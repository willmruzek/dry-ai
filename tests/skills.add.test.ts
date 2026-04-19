import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCLI } from '../src/cli.js';
import {
  type MockFileSystemState,
  type MockedFsObject,
  type MockedGitObject,
  type MockedOsObject,
  type TestEnv,
  configureMockFileSystem,
  configureMockGitClient,
  configureMockOs,
  createMockFileSystemState,
  createTestEnv as createBaseTestEnv,
  ensureMockDirectory,
  mockPathExists,
  readMockTextFile,
  storeMockTextFile,
} from './helpers.js';

const CONFIG_ROOT = '/virtual/config';
const VIRTUAL_HOME_DIR = '/virtual/home';
const DEFAULT_CONFIG_ROOT = path.join(VIRTUAL_HOME_DIR, '.config', 'dryai');
const SKILLS_LOCKFILE_PATH = path.join(CONFIG_ROOT, 'skills.lock.json');
const MANAGED_SKILL_NAME = 'review-helper';
const MANAGED_SKILL_PATH = 'skills/review-helper';
const IMPORTED_AT = '2026-04-14T00:00:00.000Z';
const FETCHED_COMMIT = 'abcdef1234567890';

const REMOTE_SKILL_FILES = {
  'SKILL.md': '---\nname: review-helper\n---\n\n# Review Helper\n',
  'guides/checklist.md': '- verify tests\n',
  'rules.md': 'Check edge cases.\n',
} as const;

const mockedFs = vi.hoisted(() => ({
  copy: vi.fn(),
  ensureDir: vi.fn(),
  mkdtemp: vi.fn(),
  move: vi.fn(),
  pathExists: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  remove: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

const mockedGit = {
  addRemote: vi.fn(),
  checkout: vi.fn(),
  fetch: vi.fn(),
  init: vi.fn(),
  revparse: vi.fn(),
};

const mockedOs = vi.hoisted(() => ({
  homedir: vi.fn(),
  tmpdir: vi.fn(),
}));

vi.mock('fs-extra', () => ({
  default: mockedFs,
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: mockedOs,
}));

/**
 * Seeds one freshly cloned repository checkout with the managed skill fixture files.
 */
function seedRemoteSkillCheckout(
  state: MockFileSystemState,
  checkoutDir: string,
): void {
  const remoteSkillDir = path.join(checkoutDir, MANAGED_SKILL_PATH);
  ensureMockDirectory(state, remoteSkillDir);

  for (const [relativeFilePath, content] of Object.entries(
    REMOTE_SKILL_FILES,
  )) {
    storeMockTextFile(
      state,
      path.join(remoteSkillDir, relativeFilePath),
      content,
    );
  }
}

/**
 * Creates the expected SHA-256 hashes for the remote skill fixture files.
 */
function createExpectedFileHashes(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(REMOTE_SKILL_FILES)
      .map(([relativeFilePath, content]) => [
        relativeFilePath,
        createHash('sha256').update(content).digest('hex'),
      ])
      .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath)),
  );
}

/**
 * Creates a test environment with the virtual config and output roots pre-filled.
 */
function createTestEnv({
  defaultConfigRoot = DEFAULT_CONFIG_ROOT,
  defaultOutputRoot = VIRTUAL_HOME_DIR,
}: {
  defaultConfigRoot?: string;
  defaultOutputRoot?: string;
} = {}): TestEnv {
  return createBaseTestEnv({ defaultConfigRoot, defaultOutputRoot });
}

describe('dryai skills add', () => {
  let mockFileSystem: MockFileSystemState;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem(mockFileSystem, mockedFs as MockedFsObject, {
      lockfilePath: SKILLS_LOCKFILE_PATH,
      onMkdtemp: (state, tempDir, prefix) => {
        if (path.basename(prefix).startsWith('agents-skill.')) {
          seedRemoteSkillCheckout(state, tempDir);
        }
      },
    });
    configureMockGitClient(mockedGit as MockedGitObject, {
      fetchedCommit: FETCHED_COMMIT,
    });
    configureMockOs(mockedOs as MockedOsObject, {
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(IMPORTED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('single skill import', () => {
    it.each([
      ['anthropics/skills'],
      ['anthropics/skills.git'],
      ['https://github.com/anthropics/skills.git'],
    ])('imports one skill when repo is provided as %s', async (repo) => {
      // Arrange
      const environment = createTestEnv();
      const defaultSkillsLockfilePath = path.join(
        environment.defaultConfigRoot,
        'skills.lock.json',
      );
      const defaultSkillsSourceRoot = path.join(
        environment.defaultConfigRoot,
        'skills',
      );
      const normalizedRepo = 'https://github.com/anthropics/skills.git';
      const expectedFileHashes = createExpectedFileHashes();
      const targetSkillDir = path.join(
        defaultSkillsSourceRoot,
        MANAGED_SKILL_NAME,
      );

      // Act
      await runCLI({
        argv: ['skills', 'add', repo, '--skill', 'review-helper'],
        ...environment.cliOptions,
      });

      // Assert: success message written through the CLI runtime
      expect(environment.stderrMessages).toEqual([]);
      expect(environment.stdoutMessages).toEqual([
        `Imported ${MANAGED_SKILL_NAME} repo=${normalizedRepo} path=${MANAGED_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
      ]);

      // Assert: git clone sequence executed correctly
      expect(mockedGit.init).toHaveBeenCalled();
      expect(mockedGit.addRemote).toHaveBeenCalledWith(
        'origin',
        normalizedRepo,
      );
      expect(mockedGit.fetch).toHaveBeenCalledWith('origin', 'HEAD', [
        '--depth',
        '1',
      ]);
      expect(mockedGit.checkout).toHaveBeenCalledWith([
        '--quiet',
        'FETCH_HEAD',
      ]);
      expect(mockedGit.revparse).toHaveBeenCalledWith(['HEAD']);

      // Assert: lockfile written twice — once to initialize, once with the added skill
      const savedLockfile = JSON.parse(
        readMockTextFile(mockFileSystem, defaultSkillsLockfilePath),
      ) as unknown;
      expect(savedLockfile).toEqual({
        version: 1,
        skills: [
          {
            commit: FETCHED_COMMIT,
            files: expectedFileHashes,
            importedAt: IMPORTED_AT,
            name: MANAGED_SKILL_NAME,
            path: MANAGED_SKILL_PATH,
            repo: normalizedRepo,
            updatedAt: IMPORTED_AT,
          },
        ],
      });

      // Assert: skill files copied into the config source root
      expect(
        readMockTextFile(mockFileSystem, path.join(targetSkillDir, 'SKILL.md')),
      ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
      expect(
        readMockTextFile(
          mockFileSystem,
          path.join(targetSkillDir, 'guides', 'checklist.md'),
        ),
      ).toBe(REMOTE_SKILL_FILES['guides/checklist.md']);
      expect(
        readMockTextFile(mockFileSystem, path.join(targetSkillDir, 'rules.md')),
      ).toBe(REMOTE_SKILL_FILES['rules.md']);

      // Assert: both temporary directories (checkout and staging) cleaned up after import
      expect(mockFileSystem.tempDirectories).toHaveLength(2);
      const [checkoutDirectory, stagingDirectory] =
        mockFileSystem.tempDirectories;

      if (!checkoutDirectory || !stagingDirectory) {
        throw new Error('Expected exactly two temporary directories.');
      }

      expect(mockPathExists(mockFileSystem, checkoutDirectory)).toBe(false);
      expect(mockPathExists(mockFileSystem, stagingDirectory)).toBe(false);
    });
  });

  describe('flag variations', () => {
    it.todo(
      'stores the provided --ref string in the lockfile instead of the commit hash when --pin is not set',
    );

    it.todo('stores the skill under the --as name in the lockfile and on disk');

    it.todo(
      'resolves each skill path relative to --path instead of the default skills/ directory',
    );
  });

  describe('multiple skills', () => {
    it.todo(
      'imports multiple skills in one invocation and writes the lockfile once per skill',
    );

    it.todo(
      'de-duplicates repeated --skill values, importing each skill only once',
    );
  });

  describe('skipping already-imported skills', () => {
    it.todo(
      'skips a skill that is already present in the lockfile and still imports the remaining requested skills',
    );

    it.todo(
      'warns about all skipped skills when every requested skill is already imported and logs "No skills were imported."',
    );
  });

  describe('config and output roots', () => {
    it.todo(
      'imports a skill using the default config root and output root when neither flag is passed',
    );

    it.todo(
      'uses ./output-test as output root when --test is passed without an explicit --output-root',
    );

    it.todo.each([
      ['--config-root', '~'],
      ['--config-root', '~/subpath'],
      ['--output-root', '~'],
      ['--output-root', '~/subpath'],
    ])('expands %s value %s to the home directory', async () => {});
  });

  describe('error cases', () => {
    it.todo('throws when --skill is omitted');

    it.todo('throws when --as is combined with more than one --skill');

    it.todo(
      'throws when the target skill directory already exists on disk but is absent from the lockfile',
    );

    it.todo(
      'cleans up temporary directories even when an error is thrown mid-import',
    );
  });
});
