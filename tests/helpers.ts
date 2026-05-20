import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { SystemError } from '@effect/platform/Error';
import {
  layerNoop as fileSystemLayerNoop,
  Size,
  type File,
  type FileSystem,
  type MakeTempDirectoryOptions,
} from '@effect/platform/FileSystem';
import { Effect } from 'effect';
import type { Layer } from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import { enableMapSet, produce, type Draft } from 'immer';
import { simpleGit } from 'simple-git';
import { vi } from 'vitest';
import type { MockedObject } from 'vitest';

import { type CLIOptions, type StdioWriters } from '../src/cli.js';
import { createMessageOnlyLoggerLayer } from '../src/lib/logger-layer.js';

enableMapSet();

// ---- Types ----

export type MockDirectoryEntry = {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
};

export type MockStatResult = {
  isDirectory: () => boolean;
  isFile: () => boolean;
};

/**
 * In-memory filesystem snapshot stored in a Ref. Updated only via `produce` or
 * fresh replacements so logical state moves forward immutably between commits.
 */
export type MockFsSnapshot = {
  directories: Set<string>;
  files: Map<string, string>;
  lockfileWrites: string[];
  tempDirectories: string[];
  nextTempId: number;
  trackedLockfilePath?: string;
};

/**
 * Path-keyed failure messages for Effect `FileSystem` operations in tests.
 */
export type MockFsFailures = {
  readFileString: Map<string, string>;
  readFileBytes: Map<string, string>;
  writeFile: Map<string, string>;
  remove: Map<string, string>;
  copyDest: Map<string, string>;
  makeDirectory: Map<string, string>;
  exists: Map<string, string>;
  readDirectory: Map<string, string>;
  stat: Map<string, string>;
};

function createEmptyMockFsSnapshot(): MockFsSnapshot {
  return {
    directories: new Set<string>(['/']),
    files: new Map<string, string>(),
    lockfileWrites: [],
    tempDirectories: [],
    nextTempId: 1,
  };
}

function createEmptyMockFsFailures(): MockFsFailures {
  return {
    readFileString: new Map(),
    readFileBytes: new Map(),
    writeFile: new Map(),
    remove: new Map(),
    copyDest: new Map(),
    makeDirectory: new Map(),
    exists: new Map(),
    readDirectory: new Map(),
    stat: new Map(),
  };
}

/**
 * Ref-backed mock filesystem for tests. Use {@link createMockFileSystemState}
 * to construct; pass into {@link createTestEnv} and `configureMockFileSystem`.
 */
export class MockFileSystemHandle {
  readonly snapshotRef: Ref.Ref<MockFsSnapshot>;
  readonly failuresRef: Ref.Ref<MockFsFailures>;

  private constructor(
    snapshotRef: Ref.Ref<MockFsSnapshot>,
    failuresRef: Ref.Ref<MockFsFailures>,
  ) {
    this.snapshotRef = snapshotRef;
    this.failuresRef = failuresRef;
  }

  static createEmpty(): MockFileSystemHandle {
    const snapshotRef = Effect.runSync(Ref.make(createEmptyMockFsSnapshot()));
    const failuresRef = Effect.runSync(Ref.make(createEmptyMockFsFailures()));
    return new MockFileSystemHandle(snapshotRef, failuresRef);
  }

  getSnapshot(): MockFsSnapshot {
    return Effect.runSync(Ref.get(this.snapshotRef));
  }

  /** Shallow copy for assertions — do not mutate. */
  get files(): ReadonlyMap<string, string> {
    return new Map(this.getSnapshot().files);
  }

  /** Shallow copy for assertions — do not mutate. */
  get directories(): ReadonlySet<string> {
    return new Set(this.getSnapshot().directories);
  }

  get lockfileWrites(): readonly string[] {
    return [...this.getSnapshot().lockfileWrites];
  }

  get tempDirectories(): readonly string[] {
    return [...this.getSnapshot().tempDirectories];
  }

  get nextTempId(): number {
    return this.getSnapshot().nextTempId;
  }
}

export type MockedGitObject = MockedObject<
  Pick<
    ReturnType<typeof simpleGit>,
    'addRemote' | 'checkout' | 'fetch' | 'init' | 'revparse'
  >
>;

export type MockedOsObject = MockedObject<
  Pick<typeof os, 'homedir' | 'tmpdir'>
>;

export type TestEnv = {
  defaultConfigRoot: string;
  defaultOutputRoot: string;
  cliOptions: CLIOptions;
  mockFileSystem: MockFileSystemHandle;
  /** Commander `configureOutput` only (help, version, parse errors). */
  cmderStderrMessages: string[];
  cmderStdoutMessages: string[];
  /** Effect `Logger` only — same level routing as before (info → out, warn/error → err). */
  effectStderrMessages: string[];
  effectStdoutMessages: string[];
};

// ---- CLI test helpers ----

/**
 * Stdio writers for tests: accumulate stdout and stderr writes into in-memory
 * arrays instead of hitting the real process streams, so tests can assert on
 * the exact bytes the CLI emitted.
 */
type TestStdioWriters = StdioWriters & {
  cmderStdoutMessages: string[];
  cmderStderrMessages: string[];
};

/**
 * Creates stdio writers that push every write into the exposed
 * `cmderStdoutMessages` / `cmderStderrMessages` arrays for test assertions.
 */
export function createTestStdioWriters(): TestStdioWriters {
  const cmderStdoutMessages: string[] = [];
  const cmderStderrMessages: string[] = [];

  return {
    cmderStdoutMessages,
    cmderStderrMessages,
    writeOut(output) {
      cmderStdoutMessages.push(output);
    },
    writeErr(output) {
      cmderStderrMessages.push(output);
    },
  };
}

/**
 * Test-only Effect logger: plain message + newline; captured in dedicated
 * buffers separate from Commander {@link StdioWriters}.
 */
export function createTestEffectLoggerLayer(options: {
  effectStdoutMessages: string[];
  effectStderrMessages: string[];
}): Layer<never> {
  const { effectStdoutMessages, effectStderrMessages } = options;

  return createMessageOnlyLoggerLayer({
    writeOut: (line) => {
      effectStdoutMessages.push(line);
    },
    writeErr: (line) => {
      effectStderrMessages.push(line);
    },
  });
}

function mockPathExistsSnapshot(
  snapshot: MockFsSnapshot,
  targetPath: string,
): boolean {
  const normalizedTargetPath = normalizeMockPath(targetPath);
  return (
    snapshot.directories.has(normalizedTargetPath) ||
    snapshot.files.has(normalizedTargetPath)
  );
}

function listMockDirectoryEntriesFromSnapshot(
  snapshot: MockFsSnapshot,
  directoryPath: string,
): MockDirectoryEntry[] {
  const normalizedDirectoryPath = normalizeMockPath(directoryPath);

  if (!snapshot.directories.has(normalizedDirectoryPath)) {
    throw new Error(
      `Mock directory does not exist: ${normalizedDirectoryPath}`,
    );
  }

  const entryKinds = new Map<string, 'directory' | 'file'>();

  for (const existingDirectory of snapshot.directories) {
    if (existingDirectory === normalizedDirectoryPath) {
      continue;
    }

    if (
      !isSameOrDescendantPath({
        parentPath: normalizedDirectoryPath,
        candidatePath: existingDirectory,
      })
    ) {
      continue;
    }

    const relativePath = path.relative(
      normalizedDirectoryPath,
      existingDirectory,
    );

    if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
      continue;
    }

    const [entryName] = relativePath.split(path.sep);

    if (entryName && entryName.length > 0) {
      entryKinds.set(entryName, 'directory');
    }
  }

  for (const existingFilePath of snapshot.files.keys()) {
    if (
      !isSameOrDescendantPath({
        parentPath: normalizedDirectoryPath,
        candidatePath: existingFilePath,
      })
    ) {
      continue;
    }

    const relativePath = path.relative(
      normalizedDirectoryPath,
      existingFilePath,
    );

    if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
      continue;
    }

    const pathSegments = relativePath.split(path.sep);
    const entryName = pathSegments[0];

    if (!entryName) {
      continue;
    }

    if (pathSegments.length === 1) {
      if (!entryKinds.has(entryName)) {
        entryKinds.set(entryName, 'file');
      }

      continue;
    }

    entryKinds.set(entryName, 'directory');
  }

  return [...entryKinds.entries()]
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    .map(([entryName, entryKind]) => ({
      name: entryName,
      isDirectory: () => entryKind === 'directory',
      isFile: () => entryKind === 'file',
    }));
}

function getMockStatResultFromSnapshot(
  snapshot: MockFsSnapshot,
  targetPath: string,
): MockStatResult {
  const normalizedTargetPath = normalizeMockPath(targetPath);

  if (snapshot.directories.has(normalizedTargetPath)) {
    return {
      isDirectory: () => true,
      isFile: () => false,
    };
  }

  if (snapshot.files.has(normalizedTargetPath)) {
    return {
      isDirectory: () => false,
      isFile: () => true,
    };
  }

  throw new Error(`Mock path does not exist: ${normalizedTargetPath}`);
}

function ensureMockDirectoryOnDraft(
  draft: Draft<MockFsSnapshot>,
  directoryPath: string,
): void {
  let currentPath = normalizeMockPath(directoryPath);

  while (!draft.directories.has(currentPath)) {
    draft.directories.add(currentPath);
    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }
}

/**
 * Creates a FileSystem Layer backed by an immutable Ref snapshot (never touches real disk).
 */
export function mockFileSystemLayer(
  handle: MockFileSystemHandle,
): Layer<FileSystem> {
  return fileSystemLayerNoop({
    exists: (filePath: string) =>
      Effect.gen(function* () {
        const norm = normalizeMockPath(filePath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.exists.get(norm);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'exists',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: filePath,
          });
        }
        return mockPathExistsSnapshot(handle.getSnapshot(), filePath);
      }),

    makeDirectory: (directoryPath: string, options?: { recursive?: boolean }) =>
      Effect.gen(function* () {
        const normalizedDirectoryPath = normalizeMockPath(directoryPath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.makeDirectory.get(normalizedDirectoryPath);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'makeDirectory',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: directoryPath,
          });
        }

        yield* Ref.update(handle.snapshotRef, (s) =>
          produce(s, (draft) => {
            if (options?.recursive === true) {
              ensureMockDirectoryOnDraft(draft, directoryPath);
            } else {
              const parentDirectoryPath = path.dirname(normalizedDirectoryPath);

              if (!draft.directories.has(parentDirectoryPath)) {
                throw new Error(
                  `Mock parent directory does not exist: ${parentDirectoryPath}`,
                );
              }

              draft.directories.add(normalizedDirectoryPath);
            }
          }),
        );
      }),

    makeTempDirectory: (options?: MakeTempDirectoryOptions) =>
      Effect.gen(function* () {
        const prefix = resolveMakeTempDirectoryPrefix(options);
        const normalizedPrefix = normalizeMockPath(prefix);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.makeDirectory.get(normalizedPrefix);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'makeTempDirectory',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: prefix,
          });
        }
        return createMockTempDirectory({
          handle,
          prefix,
        });
      }),

    copy: (fromPath: string, toPath: string) =>
      Effect.gen(function* () {
        const normalizedTo = normalizeMockPath(toPath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.copyDest.get(normalizedTo);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'copy',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: toPath,
          });
        }

        yield* Effect.sync(() =>
          copyMockPath({
            handle,
            sourcePath: fromPath,
            destinationPath: toPath,
          }),
        );
      }),

    rename: (oldPath: string, newPath: string) =>
      Effect.sync(() => {
        moveMockPath({
          handle,
          sourcePath: oldPath,
          destinationPath: newPath,
          overwrite: true,
        });
      }),

    remove: (
      targetPath: string,
      options?: { force?: boolean; recursive?: boolean },
    ) =>
      Effect.gen(function* () {
        const norm = normalizeMockPath(targetPath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.remove.get(norm);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'remove',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: targetPath,
          });
        }

        const snap = yield* Ref.get(handle.snapshotRef);
        if (!mockPathExistsSnapshot(snap, targetPath)) {
          if (options?.force === true) {
            return;
          }
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'remove',
            reason: 'NotFound',
            description: 'No such file or directory',
            pathOrDescriptor: targetPath,
          });
        }

        yield* Effect.sync(() => removeMockPath({ handle, targetPath }));
      }),

    readDirectory: (directoryPath: string) =>
      Effect.gen(function* () {
        const normalizedDirectoryPath = normalizeMockPath(directoryPath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.readDirectory.get(normalizedDirectoryPath);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'readDirectory',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: directoryPath,
          });
        }

        const snap = yield* Ref.get(handle.snapshotRef);
        if (!snap.directories.has(normalizedDirectoryPath)) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'readDirectory',
            reason: 'NotFound',
            description: 'No such file or directory',
            pathOrDescriptor: directoryPath,
          });
        }

        return listMockDirectoryEntriesFromSnapshot(snap, directoryPath).map(
          (entry) => entry.name,
        );
      }),

    stat: (filePath: string) =>
      Effect.gen(function* () {
        const norm = normalizeMockPath(filePath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.stat.get(norm);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'stat',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: filePath,
          });
        }

        const snap = yield* Ref.get(handle.snapshotRef);
        if (!mockPathExistsSnapshot(snap, filePath)) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'stat',
            reason: 'NotFound',
            description: 'No such file or directory',
            pathOrDescriptor: filePath,
          });
        }

        const mockStat = getMockStatResultFromSnapshot(snap, filePath);

        const info: File.Info = {
          type: mockStat.isDirectory() ? 'Directory' : 'File',
          mtime: Option.none(),
          atime: Option.none(),
          birthtime: Option.none(),
          dev: 0,
          ino: Option.none(),
          mode: 0o644,
          nlink: Option.none(),
          uid: Option.none(),
          gid: Option.none(),
          rdev: Option.none(),
          size: Size(0n),
          blksize: Option.none(),
          blocks: Option.none(),
        };

        return info;
      }),

    readFileString: (filePath: string) =>
      Effect.gen(function* () {
        const norm = normalizeMockPath(filePath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.readFileString.get(norm);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'readFileString',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: filePath,
          });
        }

        const snap = yield* Ref.get(handle.snapshotRef);
        const content = snap.files.get(norm);

        if (content === undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'readFileString',
            reason: 'NotFound',
            description: 'No such file or directory',
            pathOrDescriptor: filePath,
          });
        }

        return content;
      }),

    readFile: (filePath: string) =>
      Effect.gen(function* () {
        const norm = normalizeMockPath(filePath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.readFileBytes.get(norm);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'readFile',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: filePath,
          });
        }

        const snap = yield* Ref.get(handle.snapshotRef);
        const content = snap.files.get(norm);

        if (content === undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'readFile',
            reason: 'NotFound',
            description: 'No such file or directory',
            pathOrDescriptor: filePath,
          });
        }

        return new TextEncoder().encode(content);
      }),

    writeFile: (filePath: string, data: Uint8Array) =>
      Effect.gen(function* () {
        const normalizedFilePath = normalizeMockPath(filePath);
        const failures = yield* Ref.get(handle.failuresRef);
        const failMsg = failures.writeFile.get(normalizedFilePath);
        if (failMsg !== undefined) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'writeFile',
            reason: 'Unknown',
            description: failMsg,
            pathOrDescriptor: filePath,
          });
        }

        const parentDirectoryPath = path.dirname(normalizedFilePath);
        const snap = yield* Ref.get(handle.snapshotRef);

        if (!snap.directories.has(parentDirectoryPath)) {
          return yield* new SystemError({
            module: 'FileSystem',
            method: 'writeFile',
            reason: 'NotFound',
            description: 'No such file or directory',
            pathOrDescriptor: filePath,
          });
        }

        const textContent = new TextDecoder('utf-8').decode(data);

        yield* Ref.update(handle.snapshotRef, (s) =>
          produce(s, (draft) => {
            draft.files.set(normalizedFilePath, textContent);

            if (
              draft.trackedLockfilePath !== undefined &&
              normalizedFilePath === draft.trackedLockfilePath
            ) {
              draft.lockfileWrites.push(textContent);
            }
          }),
        );
      }),
  });
}

/**
 * Builds a TestEnv with CLI options and an in-memory mock filesystem for tests.
 *
 * @param defaultConfigRoot - Optional override for the default configuration root used by the TestEnv.
 * @param defaultOutputRoot - Optional override for the default output root used by the TestEnv.
 * @param mockFileSystem - Optional existing MockFileSystemHandle to use; when omitted a fresh mock filesystem handle is created.
 * @returns A TestEnv with Commander (`cmderStdoutMessages` / `cmderStderrMessages`) and
 * Effect logger (`effectStdoutMessages` / `effectStderrMessages`) capture arrays.
 */
export function createTestEnv({
  defaultConfigRoot = '',
  defaultOutputRoot = '',
  mockFileSystem: mockFileSystemInput,
}: {
  defaultConfigRoot?: string;
  defaultOutputRoot?: string;
  mockFileSystem?: MockFileSystemHandle;
} = {}): TestEnv {
  const stdioWriters = createTestStdioWriters();
  const effectStdoutMessages: string[] = [];
  const effectStderrMessages: string[] = [];
  const mockFileSystem = mockFileSystemInput ?? createMockFileSystemState();

  return {
    defaultConfigRoot,
    defaultOutputRoot,
    mockFileSystem,
    cliOptions: {
      executableName: 'dry-ai',
      version: '9.9.9-test',
      stdioWriters,
      loggerLayer: createTestEffectLoggerLayer({
        effectStdoutMessages,
        effectStderrMessages,
      }),
      fileSystemLayer: mockFileSystemLayer(mockFileSystem),
    },
    cmderStderrMessages: stdioWriters.cmderStderrMessages,
    cmderStdoutMessages: stdioWriters.cmderStdoutMessages,
    effectStdoutMessages,
    effectStderrMessages,
  };
}

// ---- Mock filesystem helpers ----

/**
 * Normalizes one mock path into the same absolute form used by the production code.
 *
 * @example
 * normalizeMockPath('/virtual/config/')     // → '/virtual/config'
 * normalizeMockPath('/virtual/config/./a')  // → '/virtual/config/a'
 * normalizeMockPath('/virtual/config/../b') // → '/virtual/b'
 * normalizeMockPath('relative/path')        // → '<cwd>/relative/path'
 */
export function normalizeMockPath(filePath: string): string {
  return path.resolve(filePath);
}

/**
 * Creates one isolated in-memory filesystem handle for the current test.
 */
export function createMockFileSystemState(): MockFileSystemHandle {
  return MockFileSystemHandle.createEmpty();
}

function resolveMakeTempDirectoryPrefix(
  options?: MakeTempDirectoryOptions,
): string {
  if (options?.directory !== undefined) {
    const base = normalizeMockPath(options.directory);
    const namePrefix = options.prefix ?? '';
    return namePrefix.length > 0
      ? path.join(base, namePrefix)
      : path.join(base, 'tmp.');
  }

  if (options?.prefix !== undefined && options.prefix.length > 0) {
    return path.join(os.tmpdir(), options.prefix);
  }

  return path.join(os.tmpdir(), 'tmp.');
}

/**
 * Creates one mock temp directory (same naming scheme as Node `fs.mkdtemp`) and
 * records it on `state.tempDirectories`.
 */
export function createMockTempDirectory(options: {
  handle: MockFileSystemHandle;
  prefix: string;
}): string {
  const { handle, prefix } = options;
  const normalizedPrefix = normalizeMockPath(prefix);
  let tempDirectoryPath = '';

  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        tempDirectoryPath = `${normalizedPrefix}${String(draft.nextTempId).padStart(6, '0')}`;
        draft.nextTempId += 1;
        draft.tempDirectories.push(tempDirectoryPath);
        ensureMockDirectoryOnDraft(draft, tempDirectoryPath);
      }),
    ),
  );

  return tempDirectoryPath;
}

/**
 * Ensures one directory and all of its missing parents exist in the mock filesystem.
 */
export function ensureMockDirectory(options: {
  handle: MockFileSystemHandle;
  directoryPath: string;
}): void {
  const { handle, directoryPath } = options;
  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        ensureMockDirectoryOnDraft(draft, directoryPath);
      }),
    ),
  );
}

/**
 * Stores one text file in the mock filesystem, creating its parent directories when needed.
 */
export function storeMockTextFile(options: {
  handle: MockFileSystemHandle;
  filePath: string;
  content: string;
}): void {
  const { handle, filePath, content } = options;
  const normalizedFilePath = normalizeMockPath(filePath);

  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        ensureMockDirectoryOnDraft(draft, path.dirname(normalizedFilePath));
        draft.files.set(normalizedFilePath, content);
      }),
    ),
  );
}

/**
 * Deletes one file from the mock filesystem if it exists.
 *
 * @returns Whether a file entry was removed.
 */
export function deleteMockTextFile(options: {
  handle: MockFileSystemHandle;
  filePath: string;
}): boolean {
  const { handle, filePath } = options;
  const normalizedFilePath = normalizeMockPath(filePath);
  const snap = handle.getSnapshot();

  if (!snap.files.has(normalizedFilePath)) {
    return false;
  }

  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        draft.files.delete(normalizedFilePath);
      }),
    ),
  );

  return true;
}

/**
 * Returns whether one path currently exists in the mock filesystem.
 */
export function mockPathExists(options: {
  handle: MockFileSystemHandle;
  targetPath: string;
}): boolean {
  const { handle, targetPath } = options;
  return mockPathExistsSnapshot(handle.getSnapshot(), targetPath);
}

/**
 * Returns whether one path is equal to or nested beneath another path.
 */
export function isSameOrDescendantPath(options: {
  parentPath: string;
  candidatePath: string;
}): boolean {
  const { parentPath, candidatePath } = options;
  const relativePath = path.relative(parentPath, candidatePath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..')
  );
}

/**
 * Reads one stored text file from the mock filesystem.
 */
export function readMockTextFile(options: {
  handle: MockFileSystemHandle;
  filePath: string;
}): string {
  const { handle, filePath } = options;
  const normalizedFilePath = normalizeMockPath(filePath);
  const content = handle.getSnapshot().files.get(normalizedFilePath);

  if (content === undefined) {
    throw new Error(`Mock file does not exist: ${normalizedFilePath}`);
  }

  return content;
}

/**
 * Lists the direct children of one directory as Node's Dirent-like mock entries.
 */
export function listMockDirectoryEntries(options: {
  handle: MockFileSystemHandle;
  directoryPath: string;
}): MockDirectoryEntry[] {
  const { handle, directoryPath } = options;
  return listMockDirectoryEntriesFromSnapshot(
    handle.getSnapshot(),
    directoryPath,
  );
}

/**
 * Returns the stat-like information for one mock filesystem path.
 */
export function getMockStatResult(options: {
  handle: MockFileSystemHandle;
  targetPath: string;
}): MockStatResult {
  const { handle, targetPath } = options;
  return getMockStatResultFromSnapshot(handle.getSnapshot(), targetPath);
}

/**
 * Removes one file or directory subtree from the mock filesystem.
 */
export function removeMockPath(options: {
  handle: MockFileSystemHandle;
  targetPath: string;
}): void {
  const { handle, targetPath } = options;
  const normalizedTargetPath = normalizeMockPath(targetPath);

  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        draft.files.delete(normalizedTargetPath);

        for (const existingFilePath of [...draft.files.keys()]) {
          if (
            isSameOrDescendantPath({
              parentPath: normalizedTargetPath,
              candidatePath: existingFilePath,
            })
          ) {
            draft.files.delete(existingFilePath);
          }
        }

        for (const existingDirectory of [...draft.directories]) {
          if (
            existingDirectory !== '/' &&
            isSameOrDescendantPath({
              parentPath: normalizedTargetPath,
              candidatePath: existingDirectory,
            })
          ) {
            draft.directories.delete(existingDirectory);
          }
        }
      }),
    ),
  );
}

/**
 * Clears every descendant of one directory while keeping the directory itself.
 * Matches `fs-extra.emptyDir` semantics: if the directory does not exist yet,
 * it is created.
 */
export function emptyMockDirectory(options: {
  handle: MockFileSystemHandle;
  directoryPath: string;
}): void {
  const { handle, directoryPath } = options;
  const normalizedDirectoryPath = normalizeMockPath(directoryPath);

  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        for (const existingFilePath of [...draft.files.keys()]) {
          if (
            existingFilePath !== normalizedDirectoryPath &&
            isSameOrDescendantPath({
              parentPath: normalizedDirectoryPath,
              candidatePath: existingFilePath,
            })
          ) {
            draft.files.delete(existingFilePath);
          }
        }

        for (const existingDirectory of [...draft.directories]) {
          if (
            existingDirectory !== normalizedDirectoryPath &&
            existingDirectory !== '/' &&
            isSameOrDescendantPath({
              parentPath: normalizedDirectoryPath,
              candidatePath: existingDirectory,
            })
          ) {
            draft.directories.delete(existingDirectory);
          }
        }

        ensureMockDirectoryOnDraft(draft, normalizedDirectoryPath);
      }),
    ),
  );
}

/**
 * Copies one file or directory subtree within the mock filesystem.
 */
export function copyMockPath(options: {
  handle: MockFileSystemHandle;
  sourcePath: string;
  destinationPath: string;
}): void {
  const { handle, sourcePath, destinationPath } = options;
  const normalizedSourcePath = normalizeMockPath(sourcePath);
  const normalizedDestinationPath = normalizeMockPath(destinationPath);

  Effect.runSync(
    Ref.update(handle.snapshotRef, (s) =>
      produce(s, (draft) => {
        if (draft.files.has(normalizedSourcePath)) {
          const content = draft.files.get(normalizedSourcePath)!;
          ensureMockDirectoryOnDraft(
            draft,
            path.dirname(normalizedDestinationPath),
          );
          draft.files.set(normalizedDestinationPath, content);
          return;
        }

        if (!draft.directories.has(normalizedSourcePath)) {
          throw new Error(
            `Mock source path does not exist: ${normalizedSourcePath}`,
          );
        }

        ensureMockDirectoryOnDraft(draft, normalizedDestinationPath);

        for (const existingDirectory of [...draft.directories].sort(
          (left, right) => left.localeCompare(right),
        )) {
          if (existingDirectory === normalizedSourcePath) {
            continue;
          }

          if (
            !isSameOrDescendantPath({
              parentPath: normalizedSourcePath,
              candidatePath: existingDirectory,
            })
          ) {
            continue;
          }

          const relativePath = path.relative(
            normalizedSourcePath,
            existingDirectory,
          );
          ensureMockDirectoryOnDraft(
            draft,
            path.join(normalizedDestinationPath, relativePath),
          );
        }

        for (const [existingFilePath, content] of [
          ...draft.files.entries(),
        ].sort(([leftPath], [rightPath]) =>
          leftPath.localeCompare(rightPath),
        )) {
          if (
            !isSameOrDescendantPath({
              parentPath: normalizedSourcePath,
              candidatePath: existingFilePath,
            })
          ) {
            continue;
          }

          const relativePath = path.relative(
            normalizedSourcePath,
            existingFilePath,
          );
          const destFile = path.join(normalizedDestinationPath, relativePath);
          ensureMockDirectoryOnDraft(draft, path.dirname(destFile));
          draft.files.set(destFile, content);
        }
      }),
    ),
  );
}

/**
 * Moves one file or directory subtree within the mock filesystem.
 */
export function moveMockPath(options: {
  handle: MockFileSystemHandle;
  sourcePath: string;
  destinationPath: string;
  overwrite?: boolean;
}): void {
  const { handle, sourcePath, destinationPath, overwrite } = options;
  const normalizedDestinationPath = normalizeMockPath(destinationPath);

  if (
    !overwrite &&
    mockPathExists({ handle, targetPath: normalizedDestinationPath })
  ) {
    throw new Error(
      `Mock destination path already exists: ${normalizedDestinationPath}`,
    );
  }

  if (overwrite) {
    removeMockPath({ handle, targetPath: normalizedDestinationPath });
  }

  copyMockPath({ handle, sourcePath, destinationPath });
  removeMockPath({ handle, targetPath: sourcePath });
}

/**
 * Clears path-keyed Effect `FileSystem` failure overrides set by the `mockFail*` helpers.
 */
export function clearMockFileSystemFailures(
  handle: MockFileSystemHandle,
): void {
  Effect.runSync(Ref.set(handle.failuresRef, createEmptyMockFsFailures()));
}

export function mockFailReadFileString(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.readFileString.set(norm, message);
      }),
    ),
  );
}

export function mockFailReadFileBytes(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.readFileBytes.set(norm, message);
      }),
    ),
  );
}

export function mockFailWriteFile(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.writeFile.set(norm, message);
      }),
    ),
  );
}

export function mockFailRemove(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.remove.set(norm, message);
      }),
    ),
  );
}

export function mockFailCopyDest(options: {
  handle: MockFileSystemHandle;
  destinationPath: string;
  message: string;
}): void {
  const { handle, destinationPath, message } = options;
  const norm = normalizeMockPath(destinationPath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.copyDest.set(norm, message);
      }),
    ),
  );
}

export function mockFailMakeDirectory(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.makeDirectory.set(norm, message);
      }),
    ),
  );
}

export function mockFailExists(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.exists.set(norm, message);
      }),
    ),
  );
}

export function mockFailReadDirectory(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.readDirectory.set(norm, message);
      }),
    ),
  );
}

export function mockFailStat(options: {
  handle: MockFileSystemHandle;
  absolutePath: string;
  message: string;
}): void {
  const { handle, absolutePath, message } = options;
  const norm = normalizeMockPath(absolutePath);
  Effect.runSync(
    Ref.update(handle.failuresRef, (f) =>
      produce(f, (draft) => {
        draft.stat.set(norm, message);
      }),
    ),
  );
}

/**
 * Configures optional lockfile tracking on the mock handle.
 *
 * Call once per fresh {@link createMockFileSystemState}; for different options, create a new
 * handle instead of invoking this again on the same instance.
 *
 * @param options.lockfilePath - When provided, any write to this path is also appended to `lockfileWrites`.
 */
export function configureMockFileSystem(options: {
  handle: MockFileSystemHandle;
  lockfilePath?: string;
}): void {
  const { handle, lockfilePath } = options;
  if (lockfilePath !== undefined) {
    Effect.runSync(
      Ref.update(handle.snapshotRef, (s) =>
        produce(s, (draft) => {
          draft.trackedLockfilePath = normalizeMockPath(lockfilePath);
        }),
      ),
    );
  }
}

/**
 * Configures the node:os mock with controlled virtual home and temp directories.
 */
export function configureMockOs(options: {
  mockedOs: MockedOsObject;
  homeDir: string;
  tmpDir: string;
}): void {
  const { mockedOs, homeDir, tmpDir } = options;
  mockedOs.homedir.mockReturnValue(homeDir);
  mockedOs.tmpdir.mockReturnValue(tmpDir);
}

/**
 * True when `repoRoot` is the temp checkout directory created by `cloneRemoteRepo`
 * (`agents-skill.*`). Staging dirs from `replaceManagedSkillDirectory` use a different basename pattern.
 */
export function isAgentsSkillCloneCheckoutDir(repoRoot: string): boolean {
  return path.basename(repoRoot).startsWith('agents-skill.');
}

/**
 * Creates one fresh set of `vi.fn()` stubs shaped like the subset of
 * `simple-git`'s chain that `cloneRemoteRepo` uses. Pair with
 * `configureMockGitClient` to wire the stubs into the mocked `simpleGit(...)`
 * factory.
 *
 * @example
 * const mockedGit = createMockedGit();
 * configureMockGitClient({
 *   mockedGit,
 *   fetchedCommit: 'abc123',
 *   checkoutImplementation: async (repoRoot) => {
 *     if (!isAgentsSkillCloneCheckoutDir(repoRoot)) return;
 *     seedRemoteSkillCheckout({
 *       handle,
 *       checkoutDir: repoRoot,
 *       skillPath: 'skills/foo',
 *       files: { 'SKILL.md': '...' },
 *     });
 *   },
 * });
 */
export function createMockedGit(): MockedGitObject {
  // `vi.fn()` is typed as `Mock<...>`; simple-git methods use heavy overloads that
  // don't unify with `Mock` assignment. The stubs are configured in
  // `configureMockGitClient`; cast once at the factory boundary.
  return {
    addRemote: vi.fn(),
    checkout: vi.fn(),
    fetch: vi.fn(),
    init: vi.fn(),
    revparse: vi.fn(),
  } as MockedGitObject;
}

/**
 * Configures the simple-git mock factory and the git client used by cloneRemoteRepo.
 *
 * Pass `checkoutImplementation` to control the mocked `git.checkout` behavior.
 * `repoRoot` is the directory passed to `simpleGit(repoRoot)` for the active chain.
 * Typical skill tests guard with {@link isAgentsSkillCloneCheckoutDir} before seeding
 * so staging temp dirs from `replaceManagedSkillDirectory` stay empty.
 */
export function configureMockGitClient(options: {
  mockedGit: MockedGitObject;
  fetchedCommit: string;
  checkoutImplementation?: (repoRoot: string) => void | Promise<void>;
}): void {
  const { mockedGit, fetchedCommit, checkoutImplementation } = options;

  // The real simple-git methods resolve to richer types (InitResult,
  // FetchResult, string, etc.); our mocks only need to no-op, so cast once.
  type AwaitedReturn<T extends (...args: never[]) => unknown> = Awaited<
    ReturnType<T>
  >;

  /** Set on each `simpleGit(baseDir)` — matches `checkout`'s working directory. */
  let activeRepoRoot = '';

  mockedGit.init.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.init>,
  );
  mockedGit.addRemote.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.addRemote>,
  );
  mockedGit.fetch.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.fetch>,
  );
  mockedGit.checkout.mockImplementation((async () => {
    if (checkoutImplementation !== undefined) {
      await checkoutImplementation(activeRepoRoot);
    }
    return undefined;
  }) as unknown as typeof mockedGit.checkout);
  mockedGit.revparse.mockResolvedValue(fetchedCommit);

  // Cast needed because we only stub the methods exercised by cloneRemoteRepo.
  vi.mocked(simpleGit).mockImplementation(((baseDir: string) => {
    activeRepoRoot = baseDir;
    return {
      addRemote: mockedGit.addRemote,
      checkout: mockedGit.checkout,
      fetch: mockedGit.fetch,
      init: mockedGit.init,
      revparse: mockedGit.revparse,
    } as unknown as ReturnType<typeof simpleGit>;
  }) as unknown as typeof simpleGit);
}

// ---- Shared skill fixture constants ----

/**
 * Virtual `$HOME` directory returned by the mocked `os.homedir()`. Tests use
 * this as the anchor for the default config/output root paths that the CLI
 * derives when no `--config-root`/`--output-root` flags are passed.
 */
export const VIRTUAL_HOME_DIR = '/virtual/home';

/**
 * The default config root the CLI resolves to from `VIRTUAL_HOME_DIR` when no
 * `--config-root` flag is passed. Mirrors the real
 * `~/.config/dry-ai` layout.
 */
export const DEFAULT_CONFIG_ROOT = path.join(
  VIRTUAL_HOME_DIR,
  '.config',
  'dry-ai',
);

/**
 * Skills lockfile path under the default config root.
 */
export const DEFAULT_SKILLS_LOCKFILE_PATH = path.join(
  DEFAULT_CONFIG_ROOT,
  'skills.lock.json',
);

/**
 * Skills source directory under the default config root; holds the per-skill
 * on-disk directories managed by `skills add` / `skills update*`.
 */
export const DEFAULT_SKILLS_SOURCE_ROOT = path.join(
  DEFAULT_CONFIG_ROOT,
  'skills',
);

/**
 * Sample ISO-8601 timestamp for seeded `importedAt` / initial `updatedAt`
 * lockfile fields. Tests that pin `vi.setSystemTime` to a later date can use
 * this as a distinct "previous import time" fixture.
 */
export const SAMPLE_IMPORTED_AT = '2026-04-14T00:00:00.000Z';

/**
 * Sample normalized repository URL (HTTPS, with trailing `.git`) that
 * `normalizeRemoteRepo` would produce for the `anthropics/skills` shorthand.
 */
export const SAMPLE_NORMALIZED_REPO =
  'https://github.com/anthropics/skills.git';

// ---- Shared skill fixture helpers ----

/**
 * Computes the SHA-256 hash map for one skill's file set, keyed by portable
 * relative path (forward slashes) and sorted alphabetically by path.
 *
 * Mirrors what `computeDirectoryHashes` writes into the lockfile's
 * per-skill `files` record, so tests can construct expected lockfile entries
 * directly from their fixture content without hard-coding hex digests.
 */
export function hashFileSet(
  files: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .map(
        ([filePath, content]) =>
          [
            filePath,
            createHash('sha256').update(content).digest('hex'),
          ] as const,
      )
      .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
  );
}

/**
 * Seeds one managed skill's on-disk directory into the mock filesystem under
 * an arbitrary skills source root.
 *
 * @example
 * seedLocalSkillDirectory({
 *   handle: state,
 *   skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
 *   skillName: 'note-taker',
 *   files: { 'SKILL.md': '...', 'rules.md': '...' },
 * });
 */
export function seedLocalSkillDirectory(options: {
  handle: MockFileSystemHandle;
  skillsSourceRoot: string;
  skillName: string;
  files: Record<string, string>;
}): void {
  const { handle, skillsSourceRoot, skillName, files } = options;
  for (const [relativeFilePath, content] of Object.entries(files)) {
    storeMockTextFile({
      handle,
      filePath: path.join(skillsSourceRoot, skillName, relativeFilePath),
      content,
    });
  }
}

/**
 * Seeds one skill's fixture files into a freshly cloned remote-checkout
 * directory at the repository-relative `skillPath`.
 *
 * Callers loop over this helper when they need to populate multiple skills
 * into the same checkout (e.g. a single `skills update-all` run clones each
 * managed skill's repo once).
 *
 * @example
 * seedRemoteSkillCheckout({
 *   handle,
 *   checkoutDir,
 *   skillPath: 'skills/note-taker',
 *   files: { 'SKILL.md': '...' },
 * });
 */
export function seedRemoteSkillCheckout(options: {
  handle: MockFileSystemHandle;
  checkoutDir: string;
  skillPath: string;
  files: Record<string, string>;
}): void {
  const { handle, checkoutDir, skillPath, files } = options;
  const remoteSkillDir = path.join(checkoutDir, skillPath);
  ensureMockDirectory({ handle, directoryPath: remoteSkillDir });

  for (const [relativeFilePath, content] of Object.entries(files)) {
    storeMockTextFile({
      handle,
      filePath: path.join(remoteSkillDir, relativeFilePath),
      content,
    });
  }
}
