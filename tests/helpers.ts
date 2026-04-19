import path from 'node:path';
import { simpleGit } from 'simple-git';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
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

export type MockedFsObject = {
  copy: Mock;
  ensureDir: Mock;
  mkdtemp: Mock;
  move: Mock;
  pathExists: Mock;
  readFile: Mock;
  readdir: Mock;
  remove: Mock;
  stat: Mock;
  writeFile: Mock;
};

export type MockedGitObject = {
  addRemote: Mock;
  checkout: Mock;
  fetch: Mock;
  init: Mock;
  revparse: Mock;
};

export type MockedOsObject = {
  homedir: Mock;
  tmpdir: Mock;
};

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
      executableName: 'dryai',
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
    async (filePath: string, encoding?: BufferEncoding) => {
      const content = readMockTextFile(state, filePath);

      return encoding === 'utf8' ? content : Buffer.from(content, 'utf8');
    },
  );

  mockedFs.writeFile.mockImplementation(
    async (filePath: string, content: string | Uint8Array) => {
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
    },
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
    async (
      directoryPath: string,
      readdirOptions?: { withFileTypes?: boolean },
    ) => {
      const directoryEntries = listMockDirectoryEntries(state, directoryPath);

      return readdirOptions?.withFileTypes
        ? directoryEntries
        : directoryEntries.map((directoryEntry) => directoryEntry.name);
    },
  );

  mockedFs.stat.mockImplementation(async (targetPath: string) =>
    getMockStatResult(state, targetPath),
  );

  mockedFs.copy.mockImplementation(
    async (sourcePath: string, destinationPath: string) => {
      copyMockPath(state, sourcePath, destinationPath);
    },
  );

  mockedFs.move.mockImplementation(
    async (
      sourcePath: string,
      destinationPath: string,
      moveOptions?: { overwrite?: boolean },
    ) => {
      moveMockPath(state, sourcePath, destinationPath, moveOptions?.overwrite);
    },
  );

  mockedFs.remove.mockImplementation(async (targetPath: string) => {
    removeMockPath(state, targetPath);
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
 * Configures the simple-git mock factory and the git client used by cloneRemoteRepo.
 */
export function configureMockGitClient(
  mockedGit: MockedGitObject,
  { fetchedCommit }: { fetchedCommit: string },
): void {
  mockedGit.init.mockResolvedValue(undefined);
  mockedGit.addRemote.mockResolvedValue(undefined);
  mockedGit.fetch.mockResolvedValue(undefined);
  mockedGit.checkout.mockResolvedValue(undefined);
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

