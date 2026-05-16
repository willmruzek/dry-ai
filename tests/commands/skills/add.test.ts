import os from 'node:os';
import path from 'node:path';

import { defineFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';

import { runCLI } from '../../../src/cli.js';

import {
  DEFAULT_CONFIG_ROOT,
  DEFAULT_SKILLS_LOCKFILE_PATH,
  DEFAULT_SKILLS_SOURCE_ROOT,
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
  mockFailExists,
  mockFailMakeDirectory,
  mockFailReadFileBytes,
  mockFailReadFileString,
  mockFailRemove,
  mockFailWriteFile,
  normalizeMockPath,
  readMockTextFile,
  seedRemoteSkillCheckout,
  storeMockTextFile,
} from '../../helpers.js';

const SKILLS_LOCKFILE_PATH = DEFAULT_SKILLS_LOCKFILE_PATH;
const FETCHED_COMMIT = 'abcdef1234567890';
const REPO_SHORT = 'anthropics/skills';
const NORMALIZED_REPO = 'https://github.com/anthropics/skills.git';
const MANAGED_SKILL_NAME = 'review-helper';
const MANAGED_SKILL_PATH = 'skills/review-helper';

const REMOTE_SKILL_FILES = {
  'SKILL.md': '---\nname: review-helper\n---\n\n# Review Helper\n',
  'guides/checklist.md': '- verify tests\n',
  'rules.md': 'Check edge cases.\n',
} as const;

const SECOND_SKILL_NAME = 'note-taker';
const SECOND_SKILL_PATH = 'skills/note-taker';
const SECOND_SKILL_FILES = {
  'SKILL.md': '---\nname: note-taker\n---\n\n# Note Taker\n',
} as const;

const PATH_TOOLS_SKILL_PATH = 'tools/review-helper';
const PATH_DOT_SKILL = 'my-skill';
const PATH_DOT_SKILL_FILES = {
  'SKILL.md': '---\nname: my-skill\n---\n\n# My Skill\n',
} as const;

const invalidLockfileLine = `Could not parse the skills lockfile (${SKILLS_LOCKFILE_PATH}). Fix JSON/schema errors in that file.\n`;

const agentsSkillTempPrefix = normalizeMockPath(
  path.join('/virtual/tmp', 'agents-skill.'),
);

function wrapTestEnv(mockFileSystem: MockFileSystemHandle): TestEnv {
  return createBaseTestEnv({
    defaultConfigRoot: DEFAULT_CONFIG_ROOT,
    defaultOutputRoot: VIRTUAL_HOME_DIR,
    mockFileSystem,
  });
}

function assertNoAgentsSkillCheckoutDirs(handle: MockFileSystemHandle): void {
  expect(
    [...handle.directories].filter((d) =>
      path.basename(d).startsWith('agents-skill.'),
    ),
  ).toEqual([]);
}

function configureDefaultRemoteCheckout(handle: MockFileSystemHandle): void {
  configureMockGitClient({
    mockedGit,
    fetchedCommit: FETCHED_COMMIT,
    checkoutImplementation: async (repoRoot) => {
      if (!isAgentsSkillCloneCheckoutDir(repoRoot)) {
        return;
      }
      seedRemoteSkillCheckout({
        handle,
        checkoutDir: repoRoot,
        skillPath: MANAGED_SKILL_PATH,
        files: REMOTE_SKILL_FILES,
      });
    },
  });
}

function configureTwoSkillsRemote(handle: MockFileSystemHandle): void {
  configureMockGitClient({
    mockedGit,
    fetchedCommit: FETCHED_COMMIT,
    checkoutImplementation: async (repoRoot) => {
      if (!isAgentsSkillCloneCheckoutDir(repoRoot)) {
        return;
      }
      seedRemoteSkillCheckout({
        handle,
        checkoutDir: repoRoot,
        skillPath: MANAGED_SKILL_PATH,
        files: REMOTE_SKILL_FILES,
      });
      seedRemoteSkillCheckout({
        handle,
        checkoutDir: repoRoot,
        skillPath: SECOND_SKILL_PATH,
        files: SECOND_SKILL_FILES,
      });
    },
  });
}

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(),
    tmpdir: vi.fn(),
  },
}));

const mockedOs = vi.mocked(os);
const mockedGit = createMockedGit();

defineFeature('dry-ai skills add', (f) => {
  let mockFileSystem: MockFileSystemHandle;

  f.BeforeEachScenario(() => {
    mockFileSystem = createMockFileSystemState();
    configureMockFileSystem({
      handle: mockFileSystem,
      lockfilePath: SKILLS_LOCKFILE_PATH,
    });
    configureDefaultRemoteCheckout(mockFileSystem);
    configureMockOs({
      mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });
    mockedGit.fetch.mockClear();
    mockedGit.init.mockClear();
    mockedGit.addRemote.mockClear();
    mockedGit.checkout.mockClear();
    mockedGit.revparse.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(SAMPLE_IMPORTED_AT));
  });

  f.AfterEachScenario(() => {
    vi.useRealTimers();
  });

  f.Scenario(
    'The command requires at least one `--skill` when adding from a repository',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I run add with a repo but omit `--skill`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see the no-skills validation line on stderr', () => {
        expect(env.effectStderrMessages).toEqual([
          'At least one skill name must be provided with --skill\n',
        ]);
      });
      And('stdout has no effect log lines', () => {
        expect(env.effectStdoutMessages).toEqual([]);
      });
      And('nothing changes the skills lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    '`--as` may only be used when importing exactly one skill',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I pass `--as` with two skill names', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            SECOND_SKILL_NAME,
            '--as',
            'alias',
          ],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see the as-requires-single-skill line on stderr', () => {
        expect(env.effectStderrMessages).toEqual([
          '--as may only be used when importing exactly one skill\n',
        ]);
      });
      And('stdout has no effect log lines', () => {
        expect(env.effectStdoutMessages).toEqual([]);
      });
      And('nothing changes the skills lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Import stops if the local skill folder already exists but the skill is not managed yet',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'a skill directory on disk has files but the lockfile does not list it',
        () => {
          const skillDir = path.join(
            DEFAULT_SKILLS_SOURCE_ROOT,
            MANAGED_SKILL_NAME,
          );
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(skillDir, 'SKILL.md'),
            content: REMOTE_SKILL_FILES['SKILL.md'],
          });
        },
      );
      When('I try to add that skill from the remote', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see the target directory exists line on stderr', () => {
        const skillDir = normalizeMockPath(
          path.join(DEFAULT_SKILLS_SOURCE_ROOT, MANAGED_SKILL_NAME),
        );
        expect(env.effectStderrMessages).toEqual([
          `A local skill directory already exists: ${skillDir}\n`,
        ]);
      });
      And('stdout has no effect log lines', () => {
        expect(env.effectStdoutMessages).toEqual([]);
      });
      And('no managed skill entry is persisted in the lockfile', () => {
        const raw = readMockTextFile({
          handle: mockFileSystem,
          filePath: SKILLS_LOCKFILE_PATH,
        });
        const parsed = JSON.parse(raw) as { skills: { name: string }[] };
        expect(parsed.skills.some((s) => s.name === MANAGED_SKILL_NAME)).toBe(
          false,
        );
      });
    },
  );

  f.Scenario(
    '`dry-ai skills add` rejects a flag that is not defined',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I run add with `--bogus`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--bogus', '--skill', 'x'],
          ...env.cliOptions,
          exitOverride: true,
        }).catch(() => undefined);
      });
      Then('Commander reports an unknown option on its stderr stream', () => {
        expect(env.cmderStderrMessages).toEqual([
          "error: unknown option '--bogus'\n",
        ]);
      });
      And('Commander does not write help text to stdout', () => {
        expect(env.cmderStdoutMessages).toEqual([]);
      });
      And('the Effect logger stays quiet', () => {
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
      And('the command stops before changing skills or the lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    '`dry-ai skills add` rejects extra arguments after the repository',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I pass another positional token after the repo', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            'extra-arg',
            '--skill',
            MANAGED_SKILL_NAME,
          ],
          ...env.cliOptions,
          exitOverride: true,
        }).catch(() => undefined);
      });
      Then('Commander reports too many arguments on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([
          "error: too many arguments for 'add'. Expected 1 argument but got 2.\n",
        ]);
      });
      And('Commander does not write help text to stdout', () => {
        expect(env.cmderStdoutMessages).toEqual([]);
      });
      And('the Effect logger stays quiet', () => {
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
      And('the command stops before changing skills or the lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    '`dry-ai skills add` requires the repository argument',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I run add without a `<repo>` value', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
          exitOverride: true,
        }).catch(() => undefined);
      });
      Then('Commander reports a missing repo argument on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([
          "error: missing required argument 'repo'\n",
        ]);
      });
      And('Commander does not write help text to stdout', () => {
        expect(env.cmderStdoutMessages).toEqual([]);
      });
      And('the Effect logger stays quiet', () => {
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
      And('the command stops before changing skills or the lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if the skills directory cannot be created',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'creating the skills source root is set up to fail (simulated)',
        () => {
          mockFailMakeDirectory({
            handle: mockFileSystem,
            absolutePath: DEFAULT_SKILLS_SOURCE_ROOT,
            message: 'mkdir skills root failed (test)',
          });
        },
      );
      When('I run a normal import', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then(
        'I see an error that the skills directory could not be created',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not create the skills directory: ${DEFAULT_SKILLS_SOURCE_ROOT}\n`,
          ]);
        },
      );
      And('nothing writes the lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if the skills lockfile cannot be checked',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('checking whether the lockfile exists fails (simulated)', () => {
        mockFailExists({
          handle: mockFileSystem,
          absolutePath: SKILLS_LOCKFILE_PATH,
          message: 'exists failed (test)',
        });
      });
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see an error that the lockfile could not be checked', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not check the skills lockfile: ${SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });
      And('no lockfile writes are recorded', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if the skills lockfile cannot be read',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('a lockfile exists but reading it fails (simulated)', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({ version: 1, skills: [] }),
        });
        mockFailReadFileString({
          handle: mockFileSystem,
          absolutePath: SKILLS_LOCKFILE_PATH,
          message: 'read failed (test)',
        });
      });
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see an error that the lockfile could not be read', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not read the skills lockfile: ${SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });
      And('no successful import occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if the existing lockfile is invalid',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('the lockfile on disk is not valid JSON', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: SKILLS_LOCKFILE_PATH,
          content: '{"version":1,"skills":[}',
        });
      });
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see an error explaining the lockfile could not be parsed', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });
      And(
        'the broken lockfile is not overwritten by a successful import',
        () => {
          expect(env.effectStdoutMessages).toEqual([]);
        },
      );
    },
  );

  f.Scenario(
    'Add stops with an error if cloning the repository fails',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('git fetch is configured to reject', () => {
        mockedGit.fetch.mockRejectedValue(
          new Error('simulated network failure'),
        );
      });
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see an error that the repository could not be fetched', () => {
        expect(env.effectStderrMessages).toEqual([
          `Failed to fetch repository from ${NORMALIZED_REPO}\n`,
        ]);
      });
      And('no import or lockfile update from the import runs', () => {
        expect(
          mockFileSystem.files.has(
            path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              MANAGED_SKILL_NAME,
              'SKILL.md',
            ),
          ),
        ).toBe(false);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if a temporary clone directory cannot be created',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'creating the temp clone directory is set up to fail (simulated)',
        () => {
          mockFailMakeDirectory({
            handle: mockFileSystem,
            absolutePath: agentsSkillTempPrefix,
            message: 'mkdtemp failed (test)',
          });
        },
      );
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see an error about the temporary clone directory', () => {
        expect(env.effectStderrMessages).toEqual([
          'Could not create a temporary directory for cloning (prefix agents-skill.).\n',
        ]);
      });
      And('no managed skill directory is created', () => {
        expect(mockPathExistsInSkills(MANAGED_SKILL_NAME)).toBe(false);
      });
    },
  );

  function mockPathExistsInSkills(skillName: string): boolean {
    return mockFileSystem.files.has(
      path.join(DEFAULT_SKILLS_SOURCE_ROOT, skillName, 'SKILL.md'),
    );
  }

  f.Scenario(
    'Add stops with an error if the skill path is missing in the cloned repository',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('the checkout seeds no matching skill tree', () => {
        configureMockGitClient({
          mockedGit,
          fetchedCommit: FETCHED_COMMIT,
          checkoutImplementation: async (repoRoot) => {
            if (!isAgentsSkillCloneCheckoutDir(repoRoot)) {
              return;
            }
            // empty checkout
          },
        });
      });
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see that the skill path was not found in the repository', () => {
        expect(env.effectStderrMessages).toEqual([
          `That skill path was not found in the repository: ${MANAGED_SKILL_PATH}\n`,
        ]);
      });
      And('temporary clone directories are cleaned up', () => {
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if installing the copied skill onto disk fails',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      const targetDir = normalizeMockPath(
        path.join(DEFAULT_SKILLS_SOURCE_ROOT, MANAGED_SKILL_NAME),
      );
      Given(
        'removing the destination skill directory fails during install (simulated)',
        () => {
          mockFailRemove({
            handle: mockFileSystem,
            absolutePath: targetDir,
            message: 'replace-remove failed (test)',
          });
        },
      );
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then(
        'I see an error that files could not be installed into the skill folder',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not install skill files into: ${targetDir}\n`,
          ]);
        },
      );
      And('temporary clone directories are cleaned up', () => {
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'Add stops with an error if hashing the remote snapshot fails before install',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'the remote checkout is seeded but reading SKILL.md for hashing fails (simulated)',
        () => {
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
              const skillMd = normalizeMockPath(
                path.join(
                  repoRoot,
                  ...MANAGED_SKILL_PATH.split('/'),
                  'SKILL.md',
                ),
              );
              mockFailReadFileBytes({
                handle: mockFileSystem,
                absolutePath: skillMd,
                message: 'hash read failed (test)',
              });
            },
          });
        },
      );
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see an error while hashing the skill content', () => {
        const msg = env.effectStderrMessages[0] ?? '';
        expect(msg).toContain(
          'Could not read file while hashing skill content',
        );
      });
      And('temporary clone directories are cleaned up', () => {
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'If saving the lockfile fails after files were installed, the skill folder is rolled back and a specific error is shown',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'the lockfile already exists so setup does not need to write it, but persisting after install fails (simulated)',
        () => {
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({ version: 1, skills: [] }),
          });
          mockFailWriteFile({
            handle: mockFileSystem,
            absolutePath: SKILLS_LOCKFILE_PATH,
            message: 'save after install failed (test)',
          });
        },
      );
      When('I run add', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('I see the lockfile-after-install failure line', () => {
        const targetDir = normalizeMockPath(
          path.join(DEFAULT_SKILLS_SOURCE_ROOT, MANAGED_SKILL_NAME),
        );
        expect(env.effectStderrMessages).toEqual([
          `Failed to persist skills lockfile after installing to ${targetDir} (installed files removal was attempted)\n`,
        ]);
      });
      And('the installed skill directory is removed', () => {
        expect(mockPathExistsInSkills(MANAGED_SKILL_NAME)).toBe(false);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'When importing two skills, a failure on the second leaves the first import and lockfile entry in place',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'both skills exist remotely but replacing the second fails during install (simulated)',
        () => {
          configureTwoSkillsRemote(mockFileSystem);
          const secondDir = normalizeMockPath(
            path.join(DEFAULT_SKILLS_SOURCE_ROOT, SECOND_SKILL_NAME),
          );
          mockFailRemove({
            handle: mockFileSystem,
            absolutePath: secondDir,
            message: 'second replace failed (test)',
          });
        },
      );
      When('I import both in one invocation', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            SECOND_SKILL_NAME,
          ],
          ...env.cliOptions,
        }).catch(() => undefined);
      });
      Then('the first skill is on disk with remote bytes', () => {
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              MANAGED_SKILL_NAME,
              'SKILL.md',
            ),
          }),
        ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
      });
      And('the lockfile lists the first skill and not the second', () => {
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: { name: string }[] };
        expect(saved.skills.map((s) => s.name)).toEqual([MANAGED_SKILL_NAME]);
      });
    },
  );

  f.Scenario(
    'Importing one skill from a GitHub shorthand repo records the normalized URL and copies every file',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I run add for review-helper', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: ['skills', 'add', REPO_SHORT, '--skill', MANAGED_SKILL_NAME],
          ...env.cliOptions,
        });
      });
      Then('I see one Imported line with the short commit id', () => {
        expect(env.effectStdoutMessages).toEqual([
          `Imported ${MANAGED_SKILL_NAME} repo=${NORMALIZED_REPO} path=${MANAGED_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);
      });
      And('I see no warnings', () => {
        expect(env.effectStderrMessages).toEqual([]);
      });
      And('git ran the expected clone sequence', () => {
        expect(mockedGit.init).toHaveBeenCalled();
        expect(mockedGit.addRemote).toHaveBeenCalledWith(
          'origin',
          NORMALIZED_REPO,
        );
        expect(mockedGit.fetch).toHaveBeenCalledWith('origin', 'HEAD', [
          '--depth',
          '1',
        ]);
      });
      And('the lockfile holds the new skill with file hashes', () => {
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: Record<string, unknown>[] };
        expect(saved.skills).toHaveLength(1);
        expect(saved.skills[0]).toMatchObject({
          name: MANAGED_SKILL_NAME,
          path: MANAGED_SKILL_PATH,
          repo: NORMALIZED_REPO,
          commit: FETCHED_COMMIT,
        });
      });
    },
  );

  f.Scenario(
    'With `--pin`, the lockfile ref stores the resolved commit hash',
    ({ When, Then }) => {
      let env: TestEnv;
      When('I add with `--pin`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            '--pin',
          ],
          ...env.cliOptions,
        });
      });
      Then('the saved entry `ref` equals the fetched commit', () => {
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: { ref: string }[] };
        expect(saved.skills[0]?.ref).toBe(FETCHED_COMMIT);
      });
    },
  );

  f.Scenario(
    'Without `--pin`, the lockfile ref stores the requested git ref string',
    ({ When, Then, And }) => {
      let env: TestEnv;
      When('I add with `--ref topic-branch` and no `--pin`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            '--ref',
            'topic-branch',
          ],
          ...env.cliOptions,
        });
      });
      Then('the saved entry keeps that ref label', () => {
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: { ref: string }[] };
        expect(saved.skills[0]?.ref).toBe('topic-branch');
      });
      And('fetch used that ref', () => {
        expect(mockedGit.fetch).toHaveBeenCalledWith('origin', 'topic-branch', [
          '--depth',
          '1',
        ]);
      });
    },
  );

  f.Scenario(
    '`--as` stores the skill under the chosen local name',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      const alias = 'my-alias';
      Given('the remote is seeded as usual', () => {
        configureDefaultRemoteCheckout(mockFileSystem);
      });
      When('I import with `--as`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            '--as',
            alias,
          ],
          ...env.cliOptions,
        });
      });
      Then('I see the Imported line use that name', () => {
        expect(
          env.effectStdoutMessages.some((m) => m.includes(`Imported ${alias}`)),
        ).toBe(true);
      });
      And('files live under that folder name', () => {
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(DEFAULT_SKILLS_SOURCE_ROOT, alias, 'SKILL.md'),
          }),
        ).toBe(REMOTE_SKILL_FILES['SKILL.md']);
      });
    },
  );

  f.Scenario(
    'With `--path tools`, skills resolve under that repository folder',
    ({ Given, When, Then }) => {
      let env: TestEnv;
      Given('the remote checkout has the skill under tools/', () => {
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
              skillPath: PATH_TOOLS_SKILL_PATH,
              files: REMOTE_SKILL_FILES,
            });
          },
        });
      });
      When('I pass `--path tools`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--path',
            'tools',
            '--skill',
            MANAGED_SKILL_NAME,
          ],
          ...env.cliOptions,
        });
      });
      Then('the lockfile path is tools/review-helper', () => {
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: { path: string }[] };
        expect(saved.skills[0]?.path).toBe(PATH_TOOLS_SKILL_PATH);
      });
    },
  );

  f.Scenario(
    'With `--path .`, the skill resolves from the repository root',
    ({ Given, When, Then }) => {
      let env: TestEnv;
      Given('the remote checkout has a root-level skill folder', () => {
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
              skillPath: PATH_DOT_SKILL,
              files: PATH_DOT_SKILL_FILES,
            });
          },
        });
      });
      When('I pass `--path .` and that skill name', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--path',
            '.',
            '--skill',
            PATH_DOT_SKILL,
          ],
          ...env.cliOptions,
        });
      });
      Then(
        'the managed skill name is the root-level folder name under `--path .`',
        () => {
          const saved = JSON.parse(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: SKILLS_LOCKFILE_PATH,
            }),
          ) as { skills: { name: string; path: string }[] };
          expect(saved.skills[0]?.path).toBe(PATH_DOT_SKILL);
          expect(saved.skills[0]?.name).toBe(PATH_DOT_SKILL);
        },
      );
    },
  );

  f.Scenario(
    'Multiple skills import in request order and each triggers a lockfile save',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('the remote has two skills', () => {
        configureTwoSkillsRemote(mockFileSystem);
      });
      When('I pass both names after `--skill`', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            SECOND_SKILL_NAME,
          ],
          ...env.cliOptions,
        });
      });
      Then('stdout lists imports in the same order I requested', () => {
        expect(env.effectStdoutMessages).toEqual([
          `Imported ${MANAGED_SKILL_NAME} repo=${NORMALIZED_REPO} path=${MANAGED_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
          `Imported ${SECOND_SKILL_NAME} repo=${NORMALIZED_REPO} path=${SECOND_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);
      });
      And(
        'the lockfile was written for the empty file, then incrementally',
        () => {
          expect(mockFileSystem.lockfileWrites.length).toBeGreaterThanOrEqual(
            3,
          );
          type Snapshot = { version: number; skills: { name: string }[] };
          const parsed = mockFileSystem.lockfileWrites.map(
            (raw): Snapshot => JSON.parse(raw) as Snapshot,
          );
          expect(parsed[0]).toEqual({ version: 1, skills: [] });
          const last = parsed[parsed.length - 1];
          expect(last.skills.map((s) => s.name)).toEqual([
            SECOND_SKILL_NAME,
            MANAGED_SKILL_NAME,
          ]);
        },
      );
    },
  );

  f.Scenario(
    'Repeated `--skill` values de-duplicate so each skill imports once',
    ({ When, Then }) => {
      let env: TestEnv;
      When('I pass the same skill twice', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            MANAGED_SKILL_NAME,
          ],
          ...env.cliOptions,
        });
      });
      Then('only one Imported line appears', () => {
        expect(env.effectStdoutMessages).toEqual([
          `Imported ${MANAGED_SKILL_NAME} repo=${NORMALIZED_REPO} path=${MANAGED_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);
      });
    },
  );

  f.Scenario(
    'A skill already in the lockfile is skipped while the rest still import',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given(
        'the lockfile already lists review-helper and the checkout has two skills',
        () => {
          configureTwoSkillsRemote(mockFileSystem);
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [
                {
                  commit: FETCHED_COMMIT,
                  files: hashFileSet(REMOTE_SKILL_FILES),
                  importedAt: SAMPLE_IMPORTED_AT,
                  name: MANAGED_SKILL_NAME,
                  path: MANAGED_SKILL_PATH,
                  repo: NORMALIZED_REPO,
                  updatedAt: SAMPLE_IMPORTED_AT,
                },
              ],
            }),
          });
        },
      );
      When('I request both skills', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            SECOND_SKILL_NAME,
          ],
          ...env.cliOptions,
        });
      });
      Then('I see only the new skill imported', () => {
        expect(env.effectStdoutMessages).toEqual([
          `Imported ${SECOND_SKILL_NAME} repo=${NORMALIZED_REPO} path=${SECOND_SKILL_PATH} ref=HEAD commit=abcdef1\n`,
        ]);
      });
      And('I see a skip warning for the one already managed', () => {
        expect(env.effectStderrMessages).toEqual([
          `Skipped already-imported skills: ${MANAGED_SKILL_NAME}\n`,
        ]);
      });
    },
  );

  f.Scenario(
    'When every requested skill is already managed, I see only skips and a no-import message',
    ({ Given, When, Then, And }) => {
      let env: TestEnv;
      Given('the lockfile already lists every requested skill', () => {
        configureTwoSkillsRemote(mockFileSystem);
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              {
                commit: FETCHED_COMMIT,
                files: hashFileSet(REMOTE_SKILL_FILES),
                importedAt: SAMPLE_IMPORTED_AT,
                name: MANAGED_SKILL_NAME,
                path: MANAGED_SKILL_PATH,
                repo: NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
              {
                commit: FETCHED_COMMIT,
                files: hashFileSet(SECOND_SKILL_FILES),
                importedAt: SAMPLE_IMPORTED_AT,
                name: SECOND_SKILL_NAME,
                path: SECOND_SKILL_PATH,
                repo: NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
            ],
          }),
        });
      });
      When('I request both again', async () => {
        env = wrapTestEnv(mockFileSystem);
        await runCLI({
          argv: [
            'skills',
            'add',
            REPO_SHORT,
            '--skill',
            MANAGED_SKILL_NAME,
            SECOND_SKILL_NAME,
          ],
          ...env.cliOptions,
        });
      });
      Then('I see that no skills were imported', () => {
        expect(env.effectStdoutMessages).toEqual([
          'No skills were imported.\n',
        ]);
      });
      And('the skip warning lists both names', () => {
        expect(env.effectStderrMessages).toEqual([
          `Skipped already-imported skills: ${MANAGED_SKILL_NAME}, ${SECOND_SKILL_NAME}\n`,
        ]);
      });
    },
  );
});
