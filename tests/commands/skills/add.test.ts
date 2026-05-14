import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCLI } from '../../../src/cli.js';

import {
  DEFAULT_CONFIG_ROOT,
  DEFAULT_SKILLS_LOCKFILE_PATH,
  type MockFileSystemHandle,
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
  isAgentsSkillCloneCheckoutDir,
  mockPathExists,
  readMockTextFile,
  seedRemoteSkillCheckout,
  storeMockTextFile,
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
  mockFileSystem,
}: {
  defaultConfigRoot?: string;
  defaultOutputRoot?: string;
  mockFileSystem?: MockFileSystemHandle;
} = {}): TestEnv {
  return createBaseTestEnv({
    defaultConfigRoot,
    defaultOutputRoot,
    ...(mockFileSystem !== undefined ? { mockFileSystem } : {}),
  });
}

describe('dry-ai skills add', () => {
  let mockFileSystem: MockFileSystemHandle;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem({
      handle: mockFileSystem,
      lockfilePath: SKILLS_LOCKFILE_PATH,
    });
    configureMockGitClient({
      mockedGit,
      fetchedCommit: FETCHED_COMMIT,
      checkoutImplementation: async (repoRoot) => {
        if (!isAgentsSkillCloneCheckoutDir(repoRoot)) {
          return;
        }
        seedRemoteSkillCheckout({
          handle: mockFileSystem,
          checkoutDir: repoRoot,
          skillPath: MANAGED_SKILL_PATH,
          files: REMOTE_SKILL_FILES,
        });
      },
    });
    configureMockOs({
      mockedOs: mockedOs,
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
        const environment = createTestEnv({ mockFileSystem });
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
          readMockTextFile({
            handle: mockFileSystem,
            filePath: defaultSkillsLockfilePath,
          }),
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
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(targetSkillDir, 'SKILL.md'),
          }),
        ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(targetSkillDir, 'guides', 'checklist.md'),
          }),
        ).toBe(REMOTE_SKILL_FILES['guides/checklist.md']);
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(targetSkillDir, 'rules.md'),
          }),
        ).toBe(REMOTE_SKILL_FILES['rules.md']);

        // Assert: both temporary directories (checkout and staging) cleaned up after import
        expect(mockFileSystem.tempDirectories).toHaveLength(2);
        const [checkoutDirectory, stagingDirectory] =
          mockFileSystem.tempDirectories;

        if (!checkoutDirectory || !stagingDirectory) {
          throw new Error('Expected exactly two temporary directories.');
        }

        expect(checkoutDirectory).toMatch(
          /^\/virtual\/tmp\/agents-skill\.\d+$/,
        );
        expect(
          mockPathExists({
            handle: mockFileSystem,
            targetPath: checkoutDirectory,
          }),
        ).toBe(false);
        expect(
          mockPathExists({
            handle: mockFileSystem,
            targetPath: stagingDirectory,
          }),
        ).toBe(false);
      });
    });

    describe('flag variations', () => {
      it('stores the resolved commit as the lockfile ref when --pin is passed without --ref', async () => {
        const environment = createTestEnv({ mockFileSystem });
        const defaultSkillsLockfilePath = path.join(
          environment.defaultConfigRoot,
          'skills.lock.json',
        );

        await runCLI({
          argv: [
            'skills',
            'add',
            'anthropics/skills',
            '--skill',
            MANAGED_SKILL_NAME,
            '--pin',
          ],
          ...environment.cliOptions,
        });

        const savedLockfile = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: defaultSkillsLockfilePath,
          }),
        ) as { skills: { ref: string }[] };

        expect(savedLockfile.skills[0]?.ref).toBe(FETCHED_COMMIT);
      });

      // priority: med
      it.todo(
        'stores the provided --ref string in the lockfile instead of the commit hash when --pin is not set',
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
        // Arrange: seed two skills into the same remote checkout. Use a fresh
        // mock FS so lockfile tracking targets DEFAULT_SKILLS_LOCKFILE_PATH
        // (the shared `beforeEach` tracks SKILLS_LOCKFILE_PATH under CONFIG_ROOT).
        const SECOND_SKILL_NAME = 'note-taker';
        const SECOND_SKILL_PATH = 'skills/note-taker';
        const SECOND_SKILL_FILES = {
          'SKILL.md': '---\nname: note-taker\n---\n\n# Note Taker\n',
        } as const;

        mockFileSystem = createMockFileSystemState();
        configureMockFileSystem({
          handle: mockFileSystem,
          lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
        });
        configureMockGitClient({
          mockedGit,
          fetchedCommit: FETCHED_COMMIT,
          checkoutImplementation: async (repoRoot) => {
            if (!isAgentsSkillCloneCheckoutDir(repoRoot)) {
              return;
            }
            seedRemoteSkillCheckout({
              handle: mockFileSystem,
              checkoutDir: repoRoot,
              skillPath: MANAGED_SKILL_PATH,
              files: REMOTE_SKILL_FILES,
            });
            seedRemoteSkillCheckout({
              handle: mockFileSystem,
              checkoutDir: repoRoot,
              skillPath: SECOND_SKILL_PATH,
              files: SECOND_SKILL_FILES,
            });
          },
        });

        const environment = createTestEnv({ mockFileSystem });
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
        expect(firstIncrementalWrite.skills.map((skill) => skill.name)).toEqual(
          [MANAGED_SKILL_NAME],
        );
        expect(finalWrite.skills.map((skill) => skill.name)).toEqual(
          // `saveSkillsLockfile` sorts by name; `note-taker` < `review-helper`.
          [SECOND_SKILL_NAME, MANAGED_SKILL_NAME],
        );

        // Assert: both skills' SKILL.md files are copied into the config
        // source root, proving each loop iteration completed its directory
        // replacement.
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              skillsSourceRoot,
              MANAGED_SKILL_NAME,
              'SKILL.md',
            ),
          }),
        ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              skillsSourceRoot,
              SECOND_SKILL_NAME,
              'SKILL.md',
            ),
          }),
        ).toBe(SECOND_SKILL_FILES['SKILL.md']);
      });

      it('de-duplicates repeated --skill values, importing each skill only once', async () => {
        const environment = createTestEnv({ mockFileSystem });
        const normalizedRepo = 'https://github.com/anthropics/skills.git';

        await runCLI({
          argv: [
            'skills',
            'add',
            'anthropics/skills',
            '--skill',
            MANAGED_SKILL_NAME,
            MANAGED_SKILL_NAME,
          ],
          ...environment.cliOptions,
        });

        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          `Imported ${MANAGED_SKILL_NAME} repo=${normalizedRepo} path=${MANAGED_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);
      });
    });

    describe('skipping already-imported skills', () => {
      const SECOND_SKILL_NAME = 'note-taker';
      const SECOND_SKILL_PATH = 'skills/note-taker';
      const SECOND_SKILL_FILES = {
        'SKILL.md': '---\nname: note-taker\n---\n\n# Note Taker\n',
      } as const;

      function configureRemoteWithTwoSkills(): void {
        configureMockGitClient({
          mockedGit,
          fetchedCommit: FETCHED_COMMIT,
          checkoutImplementation: async (repoRoot) => {
            if (!isAgentsSkillCloneCheckoutDir(repoRoot)) {
              return;
            }
            seedRemoteSkillCheckout({
              handle: mockFileSystem,
              checkoutDir: repoRoot,
              skillPath: MANAGED_SKILL_PATH,
              files: REMOTE_SKILL_FILES,
            });
            seedRemoteSkillCheckout({
              handle: mockFileSystem,
              checkoutDir: repoRoot,
              skillPath: SECOND_SKILL_PATH,
              files: SECOND_SKILL_FILES,
            });
          },
        });
      }

      it('skips a skill that is already present in the lockfile and still imports the remaining requested skills', async () => {
        mockFileSystem = createMockFileSystemState();
        configureMockFileSystem({
          handle: mockFileSystem,
          lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
        });
        configureRemoteWithTwoSkills();

        const normalizedRepo = 'https://github.com/anthropics/skills.git';
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              {
                commit: FETCHED_COMMIT,
                files: hashFileSet(REMOTE_SKILL_FILES),
                importedAt: SAMPLE_IMPORTED_AT,
                name: MANAGED_SKILL_NAME,
                path: MANAGED_SKILL_PATH,
                repo: normalizedRepo,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
            ],
          }),
        });

        const environment = createTestEnv({ mockFileSystem });
        const skillsSourceRoot = path.join(
          environment.defaultConfigRoot,
          'skills',
        );

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

        expect(environment.stdoutMessages).toEqual([
          `Imported ${SECOND_SKILL_NAME} repo=${normalizedRepo} path=${SECOND_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);
        expect(environment.stderrMessages).toEqual([
          `Skipped already-imported skills: ${MANAGED_SKILL_NAME}\n`,
        ]);

        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              skillsSourceRoot,
              SECOND_SKILL_NAME,
              'SKILL.md',
            ),
          }),
        ).toBe(SECOND_SKILL_FILES['SKILL.md']);
      });

      it('warns about all skipped skills when every requested skill is already imported and logs "No skills were imported."', async () => {
        mockFileSystem = createMockFileSystemState();
        configureMockFileSystem({
          handle: mockFileSystem,
          lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
        });
        configureRemoteWithTwoSkills();

        const normalizedRepo = 'https://github.com/anthropics/skills.git';
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              {
                commit: FETCHED_COMMIT,
                files: hashFileSet(REMOTE_SKILL_FILES),
                importedAt: SAMPLE_IMPORTED_AT,
                name: MANAGED_SKILL_NAME,
                path: MANAGED_SKILL_PATH,
                repo: normalizedRepo,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
              {
                commit: FETCHED_COMMIT,
                files: hashFileSet(SECOND_SKILL_FILES),
                importedAt: SAMPLE_IMPORTED_AT,
                name: SECOND_SKILL_NAME,
                path: SECOND_SKILL_PATH,
                repo: normalizedRepo,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
            ],
          }),
        });

        const environment = createTestEnv({ mockFileSystem });

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

        expect(environment.stdoutMessages).toEqual([
          'No skills were imported.\n',
        ]);
        expect(environment.stderrMessages).toEqual([
          `Skipped already-imported skills: ${MANAGED_SKILL_NAME}, ${SECOND_SKILL_NAME}\n`,
        ]);
      });
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

    it('throws when --skill is omitted', async () => {
      const environment = createTestEnv({ mockFileSystem });
      await expect(
        runCLI({
          argv: ['skills', 'add', 'anthropics/skills'],
          ...environment.cliOptions,
        }),
      ).rejects.toThrow(
        'At least one skill name must be provided with --skill',
      );
    });

    // priority: low
    it.todo(
      'throws when --skill is provided without any value (empty list after normalization)',
    );

    it('throws when --as is combined with more than one --skill', async () => {
      const environment = createTestEnv({ mockFileSystem });
      await expect(
        runCLI({
          argv: [
            'skills',
            'add',
            'anthropics/skills',
            '--skill',
            MANAGED_SKILL_NAME,
            'note-taker',
            '--as',
            'alias',
          ],
          ...environment.cliOptions,
        }),
      ).rejects.toThrow(
        '--as may only be used when importing exactly one skill',
      );
    });

    // priority: low
    it.todo.each([['.'], ['..'], ['with/slash'], ['with\\backslash']])(
      'throws "Invalid skill name" when --skill value %s is rejected by the skill-name validator',
      async () => {},
    );

    it('throws when the target skill directory already exists on disk but is absent from the lockfile', async () => {
      const environment = createTestEnv({ mockFileSystem });
      const skillDir = path.join(
        environment.defaultConfigRoot,
        'skills',
        MANAGED_SKILL_NAME,
      );
      storeMockTextFile({
        handle: mockFileSystem,
        filePath: path.join(skillDir, 'SKILL.md'),
        content: REMOTE_SKILL_FILES['SKILL.md'],
      });

      await expect(
        runCLI({
          argv: [
            'skills',
            'add',
            'anthropics/skills',
            '--skill',
            MANAGED_SKILL_NAME,
          ],
          ...environment.cliOptions,
        }),
      ).rejects.toThrow(`A local skill directory already exists: ${skillDir}`);
    });

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
