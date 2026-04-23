import { createHash } from 'node:crypto';
import type os from 'node:os';
import path from 'node:path';

import type fs from 'fs-extra';
import { simpleGit } from 'simple-git';
import { vi } from 'vitest';
import type { MockedObject } from 'vitest';

import { type CLIOptions, type StdioWriters } from '../src/cli.js';

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
 * Isolated in-memory filesystem state for one test.
 */
export type MockFileSystemState = {
  /** Tracks which paths exist as directories; pre-seeded with the filesystem root. */
  directories: Set<string>;
  /** Maps absolute file paths to their text content. */
  files: Map<string, string>;
  /** Accumulates each raw JSON string written to the watched lockfile path, in order. */
  lockfileWrites: string[];
  /** Monotonic counter used to generate unique temp directory suffixes. */
  nextTempId: number;
  /** Records every temp directory path created via mkdtemp, in creation order. */
  tempDirectories: string[];
};

export type MockedFsObject = MockedObject<
  Pick<
    typeof fs,
    | 'copy'
    | 'emptyDir'
    | 'ensureDir'
    | 'mkdtemp'
    | 'move'
    | 'pathExists'
    | 'readFile'
    | 'readdir'
    | 'remove'
    | 'stat'
    | 'writeFile'
  >
>;

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
  stderrMessages: string[];
  stdoutMessages: string[];
};

// ---- CLI test helpers ----

/**
 * Stdio writers for tests: accumulate stdout and stderr writes into in-memory
 * arrays instead of hitting the real process streams, so tests can assert on
 * the exact bytes the CLI emitted.
 */
type TestStdioWriters = StdioWriters & {
  stdoutMessages: string[];
  stderrMessages: string[];
};

/**
 * Creates stdio writers that push every write into the exposed
 * `stdoutMessages` / `stderrMessages` arrays for test assertions.
 */
export function createTestStdioWriters(): TestStdioWriters {
  const stdoutMessages: string[] = [];
  const stderrMessages: string[] = [];

  return {
    stdoutMessages,
    stderrMessages,
    writeOut(output) {
      stdoutMessages.push(output);
    },
    writeErr(output) {
      stderrMessages.push(output);
    },
  };
}

/**
 * Creates the minimal CLI options needed for tests, optionally with explicit config and output roots.
 */
export function createTestEnv({
  defaultConfigRoot = '',
  defaultOutputRoot = '',
}: {
  defaultConfigRoot?: string;
  defaultOutputRoot?: string;
} = {}): TestEnv {
  const stdioWriters = createTestStdioWriters();

  return {
    defaultConfigRoot,
    defaultOutputRoot,
    cliOptions: {
      executableName: 'dry-ai',
      version: '9.9.9-test',
      stdioWriters,
    },
    stderrMessages: stdioWriters.stderrMessages,
    stdoutMessages: stdioWriters.stdoutMessages,
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
 * Creates one isolated in-memory filesystem state for the current test.
 */
export function createMockFileSystemState(): MockFileSystemState {
  return {
    directories: new Set<string>(['/']),
    files: new Map<string, string>(),
    lockfileWrites: [],
    nextTempId: 1,
    tempDirectories: [],
  };
}

/**
 * Ensures one directory and all of its missing parents exist in the mock filesystem.
 */
export function ensureMockDirectory(
  state: MockFileSystemState,
  directoryPath: string,
): void {
  let currentPath = normalizeMockPath(directoryPath);

  while (!state.directories.has(currentPath)) {
    state.directories.add(currentPath);
    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      break;
    }

    currentPath = parentPath;
  }
}

/**
 * Stores one text file in the mock filesystem, creating its parent directories when needed.
 */
export function storeMockTextFile(
  state: MockFileSystemState,
  filePath: string,
  content: string,
): void {
  const normalizedFilePath = normalizeMockPath(filePath);
  ensureMockDirectory(state, path.dirname(normalizedFilePath));
  state.files.set(normalizedFilePath, content);
}

/**
 * Returns whether one path currently exists in the mock filesystem.
 */
export function mockPathExists(
  state: MockFileSystemState,
  targetPath: string,
): boolean {
  const normalizedTargetPath = normalizeMockPath(targetPath);

  return (
    state.directories.has(normalizedTargetPath) ||
    state.files.has(normalizedTargetPath)
  );
}

/**
 * Returns whether one path is equal to or nested beneath another path.
 */
export function isSameOrDescendantPath(
  parentPath: string,
  candidatePath: string,
): boolean {
  const relativePath = path.relative(parentPath, candidatePath);

  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..')
  );
}

/**
 * Reads one stored text file from the mock filesystem.
 */
export function readMockTextFile(
  state: MockFileSystemState,
  filePath: string,
): string {
  const normalizedFilePath = normalizeMockPath(filePath);
  const content = state.files.get(normalizedFilePath);

  if (content === undefined) {
    throw new Error(`Mock file does not exist: ${normalizedFilePath}`);
  }

  return content;
}

/**
 * Lists the direct children of one directory as Node's Dirent-like mock entries.
 */
export function listMockDirectoryEntries(
  state: MockFileSystemState,
  directoryPath: string,
): MockDirectoryEntry[] {
  const normalizedDirectoryPath = normalizeMockPath(directoryPath);

  if (!state.directories.has(normalizedDirectoryPath)) {
    throw new Error(
      `Mock directory does not exist: ${normalizedDirectoryPath}`,
    );
  }

  const entryKinds = new Map<string, 'directory' | 'file'>();

  for (const existingDirectory of state.directories) {
    if (existingDirectory === normalizedDirectoryPath) {
      continue;
    }

    if (!isSameOrDescendantPath(normalizedDirectoryPath, existingDirectory)) {
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

  for (const existingFilePath of state.files.keys()) {
    if (!isSameOrDescendantPath(normalizedDirectoryPath, existingFilePath)) {
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

/**
 * Returns the stat-like information for one mock filesystem path.
 */
export function getMockStatResult(
  state: MockFileSystemState,
  targetPath: string,
): MockStatResult {
  const normalizedTargetPath = normalizeMockPath(targetPath);

  if (state.directories.has(normalizedTargetPath)) {
    return {
      isDirectory: () => true,
      isFile: () => false,
    };
  }

  if (state.files.has(normalizedTargetPath)) {
    return {
      isDirectory: () => false,
      isFile: () => true,
    };
  }

  throw new Error(`Mock path does not exist: ${normalizedTargetPath}`);
}

/**
 * Removes one file or directory subtree from the mock filesystem.
 */
export function removeMockPath(
  state: MockFileSystemState,
  targetPath: string,
): void {
  const normalizedTargetPath = normalizeMockPath(targetPath);

  state.files.delete(normalizedTargetPath);

  for (const existingFilePath of [...state.files.keys()]) {
    if (isSameOrDescendantPath(normalizedTargetPath, existingFilePath)) {
      state.files.delete(existingFilePath);
    }
  }

  for (const existingDirectory of [...state.directories]) {
    if (
      existingDirectory !== '/' &&
      isSameOrDescendantPath(normalizedTargetPath, existingDirectory)
    ) {
      state.directories.delete(existingDirectory);
    }
  }
}

/**
 * Clears every descendant of one directory while keeping the directory itself.
 * Matches `fs-extra.emptyDir` semantics: if the directory does not exist yet,
 * it is created.
 */
export function emptyMockDirectory(
  state: MockFileSystemState,
  directoryPath: string,
): void {
  const normalizedDirectoryPath = normalizeMockPath(directoryPath);

  for (const existingFilePath of [...state.files.keys()]) {
    if (
      existingFilePath !== normalizedDirectoryPath &&
      isSameOrDescendantPath(normalizedDirectoryPath, existingFilePath)
    ) {
      state.files.delete(existingFilePath);
    }
  }

  for (const existingDirectory of [...state.directories]) {
    if (
      existingDirectory !== normalizedDirectoryPath &&
      existingDirectory !== '/' &&
      isSameOrDescendantPath(normalizedDirectoryPath, existingDirectory)
    ) {
      state.directories.delete(existingDirectory);
    }
  }

  ensureMockDirectory(state, normalizedDirectoryPath);
}

/**
 * Copies one file or directory subtree within the mock filesystem.
 */
export function copyMockPath(
  state: MockFileSystemState,
  sourcePath: string,
  destinationPath: string,
): void {
  const normalizedSourcePath = normalizeMockPath(sourcePath);
  const normalizedDestinationPath = normalizeMockPath(destinationPath);

  if (state.files.has(normalizedSourcePath)) {
    storeMockTextFile(
      state,
      normalizedDestinationPath,
      readMockTextFile(state, normalizedSourcePath),
    );
    return;
  }

  if (!state.directories.has(normalizedSourcePath)) {
    throw new Error(`Mock source path does not exist: ${normalizedSourcePath}`);
  }

  ensureMockDirectory(state, normalizedDestinationPath);

  for (const existingDirectory of [...state.directories].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (existingDirectory === normalizedSourcePath) {
      continue;
    }

    if (!isSameOrDescendantPath(normalizedSourcePath, existingDirectory)) {
      continue;
    }

    const relativePath = path.relative(normalizedSourcePath, existingDirectory);
    ensureMockDirectory(
      state,
      path.join(normalizedDestinationPath, relativePath),
    );
  }

  for (const [existingFilePath, content] of [...state.files.entries()].sort(
    ([leftPath], [rightPath]) => leftPath.localeCompare(rightPath),
  )) {
    if (!isSameOrDescendantPath(normalizedSourcePath, existingFilePath)) {
      continue;
    }

    const relativePath = path.relative(normalizedSourcePath, existingFilePath);
    storeMockTextFile(
      state,
      path.join(normalizedDestinationPath, relativePath),
      content,
    );
  }
}

/**
 * Moves one file or directory subtree within the mock filesystem.
 */
export function moveMockPath(
  state: MockFileSystemState,
  sourcePath: string,
  destinationPath: string,
  overwrite: boolean | undefined,
): void {
  const normalizedDestinationPath = normalizeMockPath(destinationPath);

  if (!overwrite && mockPathExists(state, normalizedDestinationPath)) {
    throw new Error(
      `Mock destination path already exists: ${normalizedDestinationPath}`,
    );
  }

  if (overwrite) {
    removeMockPath(state, normalizedDestinationPath);
  }

  copyMockPath(state, sourcePath, normalizedDestinationPath);
  removeMockPath(state, sourcePath);
}

// ---- Mock configure helpers ----

/**
 * Configures fs-extra mock methods against the current in-memory filesystem state.
 *
 * @param options.lockfilePath - When provided, any write to this path is also appended to `state.lockfileWrites`.
 * @param options.onMkdtemp - Called after each temp directory is created; use to seed fixture files into the checkout directory.
 */
export function configureMockFileSystem(
  state: MockFileSystemState,
  mockedFs: MockedFsObject,
  options?: {
    lockfilePath?: string;
    onMkdtemp?: (
      state: MockFileSystemState,
      tempDir: string,
      prefix: string,
    ) => void;
  },
): void {
  mockedFs.ensureDir.mockImplementation(async (directoryPath: string) => {
    ensureMockDirectory(state, directoryPath);
  });

  mockedFs.pathExists.mockImplementation(async (targetPath: string) =>
    mockPathExists(state, targetPath),
  );

  mockedFs.readFile.mockImplementation(
    // fs.readFile has many overloads; narrow here and cast once.
    (async (filePath: string, encoding?: BufferEncoding) => {
      const content = readMockTextFile(state, filePath);

      return encoding === 'utf8' ? content : Buffer.from(content, 'utf8');
    }) as unknown as typeof fs.readFile,
  );

  mockedFs.writeFile.mockImplementation(
    // fs.writeFile has many overloads; narrow here and cast once.
    (async (filePath: string, content: string | Uint8Array) => {
      const normalizedFilePath = normalizeMockPath(filePath);
      const parentDirectoryPath = path.dirname(normalizedFilePath);

      if (!state.directories.has(parentDirectoryPath)) {
        throw new Error(
          `Mock parent directory does not exist: ${parentDirectoryPath}`,
        );
      }

      const textContent =
        typeof content === 'string'
          ? content
          : Buffer.from(content).toString('utf8');

      state.files.set(normalizedFilePath, textContent);

      if (
        options?.lockfilePath !== undefined &&
        normalizedFilePath === normalizeMockPath(options.lockfilePath)
      ) {
        state.lockfileWrites.push(textContent);
      }
    }) as unknown as typeof fs.writeFile,
  );

  mockedFs.mkdtemp.mockImplementation(async (prefix: string) => {
    const tempDirectoryPath = `${prefix}${String(state.nextTempId).padStart(6, '0')}`;
    state.nextTempId += 1;
    state.tempDirectories.push(tempDirectoryPath);
    ensureMockDirectory(state, tempDirectoryPath);
    options?.onMkdtemp?.(state, tempDirectoryPath, prefix);

    return tempDirectoryPath;
  });

  mockedFs.readdir.mockImplementation(
    // fs.readdir has many overloads; narrow here and cast once.
    (async (
      directoryPath: string,
      readdirOptions?: { withFileTypes?: boolean },
    ) => {
      const directoryEntries = listMockDirectoryEntries(state, directoryPath);

      return readdirOptions?.withFileTypes
        ? directoryEntries
        : directoryEntries.map((directoryEntry) => directoryEntry.name);
    }) as unknown as typeof fs.readdir,
  );

  mockedFs.stat.mockImplementation(
    // fs.stat has many overloads; narrow here and cast once.
    (async (targetPath: string) =>
      getMockStatResult(state, targetPath)) as unknown as typeof fs.stat,
  );

  mockedFs.copy.mockImplementation(
    async (sourcePath: string, destinationPath: string) => {
      copyMockPath(state, sourcePath, destinationPath);
    },
  );

  mockedFs.move.mockImplementation(
    // fs.move's MoveOptions is stricter than we need here; cast once.
    (async (
      sourcePath: string,
      destinationPath: string,
      moveOptions?: { overwrite?: boolean },
    ) => {
      moveMockPath(state, sourcePath, destinationPath, moveOptions?.overwrite);
    }) as unknown as typeof fs.move,
  );

  mockedFs.remove.mockImplementation(async (targetPath: string) => {
    removeMockPath(state, targetPath);
  });

  mockedFs.emptyDir.mockImplementation(async (directoryPath: string) => {
    emptyMockDirectory(state, directoryPath);
  });
}

/**
 * Configures the node:os mock with controlled virtual home and temp directories.
 */
export function configureMockOs(
  mockedOs: MockedOsObject,
  { homeDir, tmpDir }: { homeDir: string; tmpDir: string },
): void {
  mockedOs.homedir.mockReturnValue(homeDir);
  mockedOs.tmpdir.mockReturnValue(tmpDir);
}

/**
 * Creates one fresh set of `vi.fn()` stubs shaped like the subset of
 * `simple-git`'s chain that `cloneRemoteRepo` uses. Pair with
 * `configureMockGitClient` to wire the stubs into the mocked `simpleGit(...)`
 * factory.
 *
 * @example
 * const mockedGit = createMockedGit();
 * configureMockGitClient(mockedGit, { fetchedCommit: 'abc123' });
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
 */
export function configureMockGitClient(
  mockedGit: MockedGitObject,
  { fetchedCommit }: { fetchedCommit: string },
): void {
  // The real simple-git methods resolve to richer types (InitResult,
  // FetchResult, string, etc.); our mocks only need to no-op, so cast once.
  type AwaitedReturn<T extends (...args: never[]) => unknown> = Awaited<
    ReturnType<T>
  >;

  mockedGit.init.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.init>,
  );
  mockedGit.addRemote.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.addRemote>,
  );
  mockedGit.fetch.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.fetch>,
  );
  mockedGit.checkout.mockResolvedValue(
    undefined as unknown as AwaitedReturn<typeof mockedGit.checkout>,
  );
  mockedGit.revparse.mockResolvedValue(fetchedCommit);

  // Cast needed because we only stub the methods exercised by cloneRemoteRepo.
  vi.mocked(simpleGit).mockImplementation(
    () =>
      ({
        addRemote: mockedGit.addRemote,
        checkout: mockedGit.checkout,
        fetch: mockedGit.fetch,
        init: mockedGit.init,
        revparse: mockedGit.revparse,
      }) as unknown as ReturnType<typeof simpleGit>,
  );
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
 * seedLocalSkillDirectory(state, DEFAULT_SKILLS_SOURCE_ROOT, 'note-taker', {
 *   'SKILL.md': '...',
 *   'rules.md': '...',
 * });
 */
export function seedLocalSkillDirectory(
  state: MockFileSystemState,
  skillsSourceRoot: string,
  skillName: string,
  files: Record<string, string>,
): void {
  for (const [relativeFilePath, content] of Object.entries(files)) {
    storeMockTextFile(
      state,
      path.join(skillsSourceRoot, skillName, relativeFilePath),
      content,
    );
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
 * seedRemoteSkillCheckout(state, checkoutDir, 'skills/note-taker', {
 *   'SKILL.md': '...',
 * });
 */
export function seedRemoteSkillCheckout(
  state: MockFileSystemState,
  checkoutDir: string,
  skillPath: string,
  files: Record<string, string>,
): void {
  const remoteSkillDir = path.join(checkoutDir, skillPath);
  ensureMockDirectory(state, remoteSkillDir);

  for (const [relativeFilePath, content] of Object.entries(files)) {
    storeMockTextFile(
      state,
      path.join(remoteSkillDir, relativeFilePath),
      content,
    );
  }
}
