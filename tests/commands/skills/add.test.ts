import os from 'node:os';
import path from 'node:path';
import fsExtra from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCLI } from '../../../src/cli.js';
import {
  DEFAULT_CONFIG_ROOT,
  type MockFileSystemState,
  SAMPLE_IMPORTED_AT,
  type TestEnv,
  VIRTUAL_HOME_DIR,
  configureMockFileSystem,
  configureMockGitClient,
  configureMockOs,
  createMockFileSystemState,
  createMockedGit,
  createTestEnv as createBaseTestEnv,
  hashFileSet,
  mockPathExists,
  readMockTextFile,
  seedRemoteSkillCheckout,
} from '../../helpers.js';

// `skills add` tests exercise an *explicit* config root (not the default),
// so the local `SKILLS_LOCKFILE_PATH` intentionally points under `CONFIG_ROOT`
// rather than reusing the shared `DEFAULT_SKILLS_LOCKFILE_PATH` export.
const CONFIG_ROOT = '/virtual/config';
const SKILLS_LOCKFILE_PATH = path.join(CONFIG_ROOT, 'skills.lock.json');
const MANAGED_SKILL_NAME = 'review-helper';
const MANAGED_SKILL_PATH = 'skills/review-helper';
const FETCHED_COMMIT = 'abcdef1234567890';

const REMOTE_SKILL_FILES = {
  'SKILL.md': '---\nname: review-helper\n---\n\n# Review Helper\n',
  'guides/checklist.md': '- verify tests\n',
  'rules.md': 'Check edge cases.\n',
} as const;

vi.mock('fs-extra', () => ({
  default: {
    copy: vi.fn(),
    emptyDir: vi.fn(),
    ensureDir: vi.fn(),
    mkdtemp: vi.fn(),
    move: vi.fn(),
    pathExists: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    remove: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(),
    tmpdir: vi.fn(),
  },
}));

// `vi.mocked` is a pure type helper: it returns the mocked default export but
// types each method as `MockedFunction<typeof fs.method>`, so
// `.mockResolvedValue` / `.mockReturnValue` calls are checked against the real
// module signatures without any explicit casts.
const mockedFs = vi.mocked(fsExtra);
const mockedOs = vi.mocked(os);

// `mockedGit` stubs the subset of simple-git's chain used by `cloneRemoteRepo`.
// It's wired into the `simpleGit(...)` factory by `configureMockGitClient`.
const mockedGit = createMockedGit();

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

describe('dry-ai skills add', () => {
  let mockFileSystem: MockFileSystemState;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem(mockFileSystem, mockedFs, {
      lockfilePath: SKILLS_LOCKFILE_PATH,
      onMkdtemp: (state, tempDir, prefix) => {
        if (path.basename(prefix).startsWith('agents-skill.')) {
          seedRemoteSkillCheckout(
            state,
            tempDir,
            MANAGED_SKILL_PATH,
            REMOTE_SKILL_FILES,
          );
        }
      },
    });
    configureMockGitClient(mockedGit, {
      fetchedCommit: FETCHED_COMMIT,
    });
    configureMockOs(mockedOs, {
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(SAMPLE_IMPORTED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy paths', () => {
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
        const expectedFileHashes = hashFileSet(REMOTE_SKILL_FILES);
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
              importedAt: SAMPLE_IMPORTED_AT,
              name: MANAGED_SKILL_NAME,
              path: MANAGED_SKILL_PATH,
              repo: normalizedRepo,
              updatedAt: SAMPLE_IMPORTED_AT,
            },
          ],
        });

        // Assert: skill files copied into the config source root
        expect(
          readMockTextFile(
            mockFileSystem,
            path.join(targetSkillDir, 'SKILL.md'),
          ),
        ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
        expect(
          readMockTextFile(
            mockFileSystem,
            path.join(targetSkillDir, 'guides', 'checklist.md'),
          ),
        ).toBe(REMOTE_SKILL_FILES['guides/checklist.md']);
        expect(
          readMockTextFile(
            mockFileSystem,
            path.join(targetSkillDir, 'rules.md'),
          ),
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
      // priority: med
      it.todo(
        'stores the provided --ref string in the lockfile instead of the commit hash when --pin is not set',
      );

      // priority: med
      it.todo(
        'stores the resolved commit as the lockfile ref when --pin is passed without --ref',
      );

      // priority: low
      it.todo(
        'stores the resolved commit as the lockfile ref when --pin is passed together with --ref (commit wins over the requested ref)',
      );

      // priority: med
      it.todo(
        'stores the skill under the --as name in the lockfile and on disk',
      );

      // priority: med
      it.todo(
        'resolves each skill path relative to --path instead of the default skills/ directory',
      );

      // priority: med
      it.todo(
        'resolves each skill from the repository root when --path . is passed',
      );

      // priority: low
      it.todo(
        'defaults the managed skill name to the repository name when --path . is passed without --as',
      );
    });

    describe('multiple skills', () => {
      it('imports multiple skills in one invocation and writes the lockfile once per skill', async () => {
        // Arrange: seed two skills into the same remote checkout. Re-call
        // `configureMockFileSystem` so `mockFileSystem.lockfileWrites` tracks
        // writes to the *default* config root's lockfile path (the shared
        // `beforeEach` tracks a different path used by other tests).
        const SECOND_SKILL_NAME = 'note-taker';
        const SECOND_SKILL_PATH = 'skills/note-taker';
        const SECOND_SKILL_FILES = {
          'SKILL.md': '---\nname: note-taker\n---\n\n# Note Taker\n',
        } as const;

        configureMockFileSystem(mockFileSystem, mockedFs, {
          lockfilePath: path.join(DEFAULT_CONFIG_ROOT, 'skills.lock.json'),
          onMkdtemp: (state, tempDir, prefix) => {
            if (!path.basename(prefix).startsWith('agents-skill.')) {
              return;
            }

            seedRemoteSkillCheckout(
              state,
              tempDir,
              MANAGED_SKILL_PATH,
              REMOTE_SKILL_FILES,
            );
            seedRemoteSkillCheckout(
              state,
              tempDir,
              SECOND_SKILL_PATH,
              SECOND_SKILL_FILES,
            );
          },
        });

        const environment = createTestEnv();
        const skillsSourceRoot = path.join(
          environment.defaultConfigRoot,
          'skills',
        );
        const normalizedRepo = 'https://github.com/anthropics/skills.git';

        // Act
        await runCLI({
          argv: [
            'skills',
            'add',
            'anthropics/skills',
            '--skill',
            MANAGED_SKILL_NAME,
            SECOND_SKILL_NAME,
          ],
          ...environment.cliOptions,
        });

        // Assert: one "Imported ..." line per skill, emitted in input order.
        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          `Imported ${MANAGED_SKILL_NAME} repo=${normalizedRepo} path=${MANAGED_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
          `Imported ${SECOND_SKILL_NAME} repo=${normalizedRepo} path=${SECOND_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);

        // Assert: the lockfile was written exactly three times:
        //   1. An initial `{ version: 1, skills: [] }` from
        //      `ensureSkillsLockfile` before any clone/import work begins.
        //   2. An incremental save after the first skill finishes importing.
        //   3. An incremental save after the second skill finishes importing.
        expect(mockFileSystem.lockfileWrites).toHaveLength(3);

        const [initialWrite, firstIncrementalWrite, finalWrite] =
          mockFileSystem.lockfileWrites.map(
            (raw) =>
              JSON.parse(raw) as {
                version: number;
                skills: { name: string }[];
              },
          );

        if (!initialWrite || !firstIncrementalWrite || !finalWrite) {
          throw new Error('Expected exactly three lockfile writes.');
        }

        expect(initialWrite).toEqual({ version: 1, skills: [] });
        expect(
          firstIncrementalWrite.skills.map((skill) => skill.name),
        ).toEqual([MANAGED_SKILL_NAME]);
        expect(finalWrite.skills.map((skill) => skill.name)).toEqual(
          // `saveSkillsLockfile` sorts by name; `note-taker` < `review-helper`.
          [SECOND_SKILL_NAME, MANAGED_SKILL_NAME],
        );

        // Assert: both skills' SKILL.md files are copied into the config
        // source root, proving each loop iteration completed its directory
        // replacement.
        expect(
          readMockTextFile(
            mockFileSystem,
            path.join(skillsSourceRoot, MANAGED_SKILL_NAME, 'SKILL.md'),
          ),
        ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
        expect(
          readMockTextFile(
            mockFileSystem,
            path.join(skillsSourceRoot, SECOND_SKILL_NAME, 'SKILL.md'),
          ),
        ).toBe(SECOND_SKILL_FILES['SKILL.md']);
      });

      // priority: low
      it.todo(
        'de-duplicates repeated --skill values, importing each skill only once',
      );
    });

    describe('skipping already-imported skills', () => {
      // priority: med
      it.todo(
        'skips a skill that is already present in the lockfile and still imports the remaining requested skills',
      );

      // priority: med
      it.todo(
        'warns about all skipped skills when every requested skill is already imported and logs "No skills were imported."',
      );
    });

    describe('config and output roots', () => {
      // priority: med
      it.todo(
        'uses ./output-test as output root when --test is passed without an explicit --output-root',
      );

      // priority: low
      it.todo.each([
        ['--config-root', '~'],
        ['--config-root', '~/subpath'],
        ['--output-root', '~'],
        ['--output-root', '~/subpath'],
      ])('expands %s value %s to the home directory', async () => {});
    });

    describe('skill source resolution', () => {
      // priority: med
      it.todo(
        'accepts a remote SKILL.md that has no frontmatter block (body-only markdown)',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills add" without a <repo> positional argument with a commander.missingArgument error',
    );

    // priority: low
    it.todo(
      'rejects "dry-ai skills add" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: med
    it.todo('throws when --skill is omitted');

    // priority: low
    it.todo(
      'throws when --skill is provided without any value (empty list after normalization)',
    );

    // priority: med
    it.todo('throws when --as is combined with more than one --skill');

    // priority: low
    it.todo.each([['.'], ['..'], ['with/slash'], ['with\\backslash']])(
      'throws "Invalid skill name" when --skill value %s is rejected by the skill-name validator',
      async () => {},
    );

    // priority: low
    it.todo(
      'throws when the target skill directory already exists on disk but is absent from the lockfile',
    );

    // priority: low
    it.todo(
      'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
    );

    // priority: med
    it.todo(
      'cleans up temporary directories even when an error is thrown mid-import',
    );

    // priority: med
    it.todo(
      'propagates git-clone errors (fetch failure) without writing to the lockfile',
    );

    // priority: low
    it.todo(
      'keeps stdout empty when the command throws before any skill imports',
    );

    describe('skill source resolution', () => {
      // priority: med
      it.todo(
        'throws when the resolved skill directory does not exist inside the cloned repository',
      );

      // priority: med
      it.todo(
        'throws when the resolved skill directory exists but does not contain a SKILL.md file',
      );

      // priority: low
      it.todo(
        'throws "Skill path is not a directory" when the resolved path exists but points to a file',
      );

      // priority: low
      it.todo(
        'throws "Skill path escapes the repository checkout" when --path walks outside the cloned repository',
      );
    });
  });
});
