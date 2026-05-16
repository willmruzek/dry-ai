import os from 'node:os';
import path from 'node:path';

import { defineFeature } from '@amiceli/vitest-cucumber';
import { expect, vi } from 'vitest';

import { runCLI } from '../../../src/cli.js';

import {
  DEFAULT_SKILLS_LOCKFILE_PATH,
  DEFAULT_SKILLS_SOURCE_ROOT,
  type MockFileSystemHandle,
  SAMPLE_IMPORTED_AT,
  SAMPLE_NORMALIZED_REPO,
  VIRTUAL_HOME_DIR,
  configureMockFileSystem,
  configureMockGitClient,
  configureMockOs,
  createMockFileSystemState,
  createMockedGit,
  createTestEnv,
  hashFileSet,
  isAgentsSkillCloneCheckoutDir,
  mockFailExists,
  mockFailReadDirectory,
  mockFailReadFileBytes,
  mockFailRemove,
  mockFailReadFileString,
  mockFailWriteFile,
  normalizeMockPath,
  readMockTextFile,
  seedLocalSkillDirectory,
  seedRemoteSkillCheckout,
  storeMockTextFile,
} from '../../helpers.js';

const UPDATED_AT = '2026-05-01T12:00:00.000Z';
const FETCHED_COMMIT = 'fedcba9876543210';

const FIRST_SKILL = {
  name: 'note-taker',
  path: 'skills/note-taker',
  originalCommit: 'abcdef1234567890',
  localFiles: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (old)\n',
  },
  remoteFiles: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (new)\n',
    'rules.md': '# new rules\n',
  },
} as const;

const SECOND_SKILL = {
  name: 'review-helper',
  path: 'skills/review-helper',
  originalCommit: '1234567890abcdef',
  localFiles: {
    'SKILL.md': '---\nname: review-helper\n---\n\n# Review helper (old)\n',
    'guides/checklist.md': '- old item\n',
  },
  remoteFiles: {
    'SKILL.md': '---\nname: review-helper\n---\n\n# Review helper (new)\n',
  },
} as const;

const FIRST_REMOTE_WITH_SUB = {
  ...FIRST_SKILL.remoteFiles,
  'sub/nested.md': 'nested\n',
} as const;

const invalidLockfileLine = `Could not parse the skills lockfile (${DEFAULT_SKILLS_LOCKFILE_PATH}). Fix JSON/schema errors in that file.\n`;

const firstSkillDir = normalizeMockPath(
  path.join(DEFAULT_SKILLS_SOURCE_ROOT, FIRST_SKILL.name),
);
const secondSkillDir = normalizeMockPath(
  path.join(DEFAULT_SKILLS_SOURCE_ROOT, SECOND_SKILL.name),
);
const firstSkillRulesPath = path.join(firstSkillDir, 'rules.md');
const firstSkillSubDir = path.join(firstSkillDir, 'sub');

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

function seedAllRemoteSkills(options: {
  handle: MockFileSystemHandle;
  checkoutDir: string;
}): void {
  const { handle, checkoutDir } = options;
  for (const skill of [FIRST_SKILL, SECOND_SKILL]) {
    seedRemoteSkillCheckout({
      handle,
      checkoutDir,
      skillPath: skill.path,
      files: skill.remoteFiles,
    });
  }
}

function lockfilePayloadFromSkills(skills: Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, skills });
}

function twoSkillEntriesInReverseNameOrder(): Record<string, unknown>[] {
  return [
    {
      commit: SECOND_SKILL.originalCommit,
      files: hashFileSet(SECOND_SKILL.localFiles),
      importedAt: SAMPLE_IMPORTED_AT,
      name: SECOND_SKILL.name,
      path: SECOND_SKILL.path,
      repo: SAMPLE_NORMALIZED_REPO,
      updatedAt: SAMPLE_IMPORTED_AT,
    },
    {
      commit: FIRST_SKILL.originalCommit,
      files: hashFileSet(FIRST_SKILL.localFiles),
      importedAt: SAMPLE_IMPORTED_AT,
      name: FIRST_SKILL.name,
      path: FIRST_SKILL.path,
      repo: SAMPLE_NORMALIZED_REPO,
      updatedAt: SAMPLE_IMPORTED_AT,
    },
  ];
}

function arrangeTwoSkillsHappyPath(handle: MockFileSystemHandle): void {
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: FIRST_SKILL.name,
    files: FIRST_SKILL.localFiles,
  });
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: SECOND_SKILL.name,
    files: SECOND_SKILL.localFiles,
  });
  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: lockfilePayloadFromSkills([
      {
        commit: FIRST_SKILL.originalCommit,
        files: hashFileSet(FIRST_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: FIRST_SKILL.name,
        path: FIRST_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
      {
        commit: SECOND_SKILL.originalCommit,
        files: hashFileSet(SECOND_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: SECOND_SKILL.name,
        path: SECOND_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
    ]),
  });
}

function arrangeSingleSkillHappyPath(handle: MockFileSystemHandle): void {
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: FIRST_SKILL.name,
    files: FIRST_SKILL.localFiles,
  });
  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: lockfilePayloadFromSkills([
      {
        commit: FIRST_SKILL.originalCommit,
        files: hashFileSet(FIRST_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: FIRST_SKILL.name,
        path: FIRST_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
    ]),
  });
}

function arrangeOneSkippedOneUpdated(handle: MockFileSystemHandle): {
  skippedSkillOnDiskFiles: Record<string, string>;
} {
  const skippedSkillOnDiskFiles = {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (user edit)\n',
  } as const;

  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: FIRST_SKILL.name,
    files: skippedSkillOnDiskFiles,
  });
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: SECOND_SKILL.name,
    files: SECOND_SKILL.localFiles,
  });

  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: lockfilePayloadFromSkills([
      {
        commit: FIRST_SKILL.originalCommit,
        files: hashFileSet(FIRST_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: FIRST_SKILL.name,
        path: FIRST_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
      {
        commit: SECOND_SKILL.originalCommit,
        files: hashFileSet(SECOND_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: SECOND_SKILL.name,
        path: SECOND_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
    ]),
  });

  return { skippedSkillOnDiskFiles };
}

function arrangeBothSkillsSkippedDueToLocalEdits(
  handle: MockFileSystemHandle,
): void {
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: FIRST_SKILL.name,
    files: {
      'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (user edit)\n',
    },
  });
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: SECOND_SKILL.name,
    files: {
      ...SECOND_SKILL.localFiles,
      'SKILL.md':
        '---\nname: review-helper\n---\n\n# Review helper (user edit)\n',
    },
  });

  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: lockfilePayloadFromSkills([
      {
        commit: FIRST_SKILL.originalCommit,
        files: hashFileSet(FIRST_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: FIRST_SKILL.name,
        path: FIRST_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
      {
        commit: SECOND_SKILL.originalCommit,
        files: hashFileSet(SECOND_SKILL.localFiles),
        importedAt: SAMPLE_IMPORTED_AT,
        name: SECOND_SKILL.name,
        path: SECOND_SKILL.path,
        repo: SAMPLE_NORMALIZED_REPO,
        updatedAt: SAMPLE_IMPORTED_AT,
      },
    ]),
  });
}

function assertNoAgentsSkillCheckoutDirs(handle: MockFileSystemHandle): void {
  expect(
    [...handle.directories].filter((d) =>
      path.basename(d).startsWith('agents-skill.'),
    ),
  ).toEqual([]);
}

defineFeature('dry-ai skills update-all', (f) => {
  let mockFileSystem: MockFileSystemHandle;

  f.BeforeEachScenario(() => {
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
        seedAllRemoteSkills({ handle: mockFileSystem, checkoutDir: repoRoot });
      },
    });
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
    vi.setSystemTime(new Date(UPDATED_AT));
  });

  f.AfterEachScenario(() => {
    vi.useRealTimers();
  });

  f.Scenario(
    'With no skills lockfile on disk, update-all says there is nothing to update',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('no skills lockfile exists on disk', () => {});

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then('I see a message that there are no managed skills to update', () => {
        expect(env.effectStdoutMessages).toEqual([
          'No managed skills to update.\n',
        ]);
      });

      And(
        'I see no warnings or errors, and the skills lockfile on disk is unchanged',
        () => {
          expect(env.effectStderrMessages).toEqual([]);
          expect(mockFileSystem.lockfileWrites).toEqual([]);
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
        },
      );
    },
  );

  f.Scenario(
    'With an empty skills list in the lockfile, update-all says there is nothing to update',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile exists with an empty skills array', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({ version: 1, skills: [] }),
        });
      });

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then('I see a message that there are no managed skills to update', () => {
        expect(env.effectStdoutMessages).toEqual([
          'No managed skills to update.\n',
        ]);
      });

      And('the skills lockfile on disk is not rewritten', () => {
        expect(mockFileSystem.lockfileWrites).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if it cannot tell whether the skills lockfile exists',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'checking whether the skills lockfile exists fails (simulated)',
        () => {
          mockFailExists({
            handle: mockFileSystem,
            absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            message: 'exists failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error saying the skills lockfile could not be checked for existence',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not check the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
          ]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if the skills lockfile cannot be read',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('a skills lockfile exists but reading it fails (simulated)', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: lockfilePayloadFromSkills([
            {
              commit: FIRST_SKILL.originalCommit,
              files: hashFileSet(FIRST_SKILL.localFiles),
              importedAt: SAMPLE_IMPORTED_AT,
              name: FIRST_SKILL.name,
              path: FIRST_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: SAMPLE_IMPORTED_AT,
            },
          ]),
        });
        mockFailReadFileString({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'read failed (test)',
        });
      });

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error saying the skills lockfile could not be read',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not read the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
          ]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if the skills lockfile is not valid JSON',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile contents are not valid JSON', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: '{"version":1,"skills":[}',
        });
      });

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error explaining the skills lockfile could not be parsed',
        () => {
          expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if the lockfile declares an unsupported format version',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile JSON declares an unsupported version', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({ version: 2, skills: [] }),
        });
      });

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error explaining the skills lockfile could not be parsed',
        () => {
          expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if the lockfile lists the same skill name twice',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile JSON lists two entries with the same skill name',
        () => {
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [
                {
                  name: 'dup-skill',
                  repo: SAMPLE_NORMALIZED_REPO,
                  path: 'skills/dup',
                  commit: 'a'.repeat(40),
                  importedAt: SAMPLE_IMPORTED_AT,
                  updatedAt: SAMPLE_IMPORTED_AT,
                },
                {
                  name: 'dup-skill',
                  repo: SAMPLE_NORMALIZED_REPO,
                  path: 'skills/dup-other',
                  commit: 'b'.repeat(40),
                  importedAt: SAMPLE_IMPORTED_AT,
                  updatedAt: SAMPLE_IMPORTED_AT,
                },
              ],
            }),
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error explaining the skills lockfile could not be parsed',
        () => {
          expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'When every managed skill can be updated, update-all refreshes them all, saves after each one, and shows no warnings',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'two managed skills are on disk with hashes matching the lockfile',
        () => {
          arrangeTwoSkillsHappyPath(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then(
        'I see a summary listing both skills in alphabetical order with the new short commit id',
        () => {
          expect(env.effectStdoutMessages).toEqual([
            [
              'Updated 2 managed skills:',
              `- ${FIRST_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${FIRST_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
              `- ${SECOND_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${SECOND_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
              '',
            ].join('\n'),
          ]);
        },
      );

      And('I see no warnings or errors', () => {
        expect(env.effectStderrMessages).toEqual([]);
      });

      And('the skills lockfile on disk was saved twice', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(2);
      });

      And(
        'each skill entry in the lockfile matches what was fetched from the remote',
        () => {
          const saved = JSON.parse(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            }),
          ) as {
            version: number;
            skills: {
              name: string;
              commit: string;
              files: Record<string, string>;
            }[];
          };
          expect(saved.skills).toEqual([
            {
              commit: FETCHED_COMMIT,
              files: hashFileSet(FIRST_SKILL.remoteFiles),
              importedAt: SAMPLE_IMPORTED_AT,
              name: FIRST_SKILL.name,
              path: FIRST_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: UPDATED_AT,
            },
            {
              commit: FETCHED_COMMIT,
              files: hashFileSet(SECOND_SKILL.remoteFiles),
              importedAt: SAMPLE_IMPORTED_AT,
              name: SECOND_SKILL.name,
              path: SECOND_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: UPDATED_AT,
            },
          ]);
        },
      );
    },
  );

  f.Scenario(
    'The success list follows alphabetical skill name order even if the lockfile file listed skills differently',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile on disk lists review-helper before note-taker in the skills array',
        () => {
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: FIRST_SKILL.name,
            files: FIRST_SKILL.localFiles,
          });
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: SECOND_SKILL.name,
            files: SECOND_SKILL.localFiles,
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: lockfilePayloadFromSkills(
              twoSkillEntriesInReverseNameOrder(),
            ),
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then(
        'I see note-taker named before review-helper in the updated summary',
        () => {
          expect(env.effectStdoutMessages[0]).toContain(
            `Updated 2 managed skills:\n- ${FIRST_SKILL.name} repo=`,
          );
          expect(env.effectStdoutMessages[0]).toContain(
            `\n- ${SECOND_SKILL.name} repo=`,
          );
        },
      );
    },
  );

  f.Scenario(
    'Update-all can refresh a single managed skill and says that one skill was updated',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists only note-taker and disk matches the lockfile hashes',
        () => {
          arrangeSingleSkillHappyPath(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then('I see that exactly one skill was updated', () => {
        expect(env.effectStdoutMessages).toEqual([
          [
            'Updated 1 managed skills:',
            `- ${FIRST_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${FIRST_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
            '',
          ].join('\n'),
        ]);
      });

      And(
        'the skills lockfile on disk is saved once with the new hashes',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        },
      );
    },
  );

  f.Scenario(
    'If the local skill folder is missing but the lockfile lists the skill, update-all still downloads and installs it',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker but no local skill directory was seeded',
        () => {
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: lockfilePayloadFromSkills([
              {
                commit: FIRST_SKILL.originalCommit,
                files: hashFileSet(FIRST_SKILL.localFiles),
                importedAt: SAMPLE_IMPORTED_AT,
                name: FIRST_SKILL.name,
                path: FIRST_SKILL.path,
                repo: SAMPLE_NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
            ]),
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then(
        'the remote files exist under the managed path with the snapshot bytes',
        () => {
          for (const [relativeFilePath, content] of Object.entries(
            FIRST_SKILL.remoteFiles,
          )) {
            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(firstSkillDir, relativeFilePath),
              }),
            ).toBe(content);
          }
        },
      );

      And('the skills lockfile on disk records the update', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
      });
    },
  );

  f.Scenario(
    'If the second skill fails during install, the first skill is still saved on disk and temporary download folders are removed',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'both skills are clean and replacing the review-helper folder fails during install (simulated)',
        () => {
          arrangeTwoSkillsHappyPath(mockFileSystem);
          mockFailRemove({
            handle: mockFileSystem,
            absolutePath: secondSkillDir,
            message: 'simulated second-skill replace failure',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await expect(
          runCLI({
            argv: ['skills', 'update-all'],
            ...env.cliOptions,
          }),
        ).rejects.toThrow(
          /Could not install skill files into: .*review-helper/,
        );
      });

      Then(
        'only one save happened: note-taker shows the new commit and review-helper is still on the old commit',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(1);
          const persisted = JSON.parse(mockFileSystem.lockfileWrites[0]) as {
            skills: {
              name: string;
              commit: string;
              files: Record<string, string>;
            }[];
          };
          expect(persisted.skills[0].commit).toBe(FETCHED_COMMIT);
          expect(persisted.skills[1].commit).toBe(SECOND_SKILL.originalCommit);
        },
      );

      And(
        'temporary download folders from the remote copies are cleaned up',
        () => {
          assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        },
      );
    },
  );

  f.Scenario(
    'If the first skill cannot be fetched from the repository, update-all stops and does not save progress',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'both skills are clean but the downloaded copy for note-taker is incomplete (missing SKILL.md)',
        () => {
          arrangeTwoSkillsHappyPath(mockFileSystem);
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
                skillPath: FIRST_SKILL.path,
                files: { 'rules.md': '# incomplete remote\n' },
              });
              seedRemoteSkillCheckout({
                handle: mockFileSystem,
                checkoutDir: repoRoot,
                skillPath: SECOND_SKILL.path,
                files: SECOND_SKILL.remoteFiles,
              });
            },
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see that the skill could not be fetched, nothing is saved for this run, and temporary download folders are removed',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Failed to fetch skill from ${SAMPLE_NORMALIZED_REPO}\n`,
          ]);
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
          assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        },
      );
    },
  );

  f.Scenario(
    'Update-all stops with an error if replacing a skill folder fails, and cleans up the download',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker is clean and removing the skill folder fails during install (simulated)',
        () => {
          arrangeSingleSkillHappyPath(mockFileSystem);
          mockFailRemove({
            handle: mockFileSystem,
            absolutePath: firstSkillDir,
            message: 'remove staging failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error that the skill files could not be installed into the skill folder',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not install skill files into: ${firstSkillDir}\n`,
          ]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if a new subfolder under the skill cannot be listed after install',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker is clean, the update adds a nested file under sub/, and listing that subfolder fails afterward (simulated)',
        () => {
          arrangeSingleSkillHappyPath(mockFileSystem);
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
                skillPath: FIRST_SKILL.path,
                files: FIRST_REMOTE_WITH_SUB,
              });
            },
          });
          mockFailReadDirectory({
            handle: mockFileSystem,
            absolutePath: firstSkillSubDir,
            message: 'read subdir failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error that the nested folder under the skill could not be scanned',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not scan skill directory: ${firstSkillSubDir}\n`,
          ]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if a file added by the update cannot be read while recording what was installed',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker is clean and reading rules.md fails while the tool records installed files (simulated)',
        () => {
          arrangeSingleSkillHappyPath(mockFileSystem);
          mockFailReadFileBytes({
            handle: mockFileSystem,
            absolutePath: firstSkillRulesPath,
            message: 'read rules failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error that rules.md could not be read under the skill folder',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not read file while hashing skill content: ${firstSkillRulesPath}\n`,
          ]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if the skills lockfile cannot be written after a successful install',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker is clean and saving the skills lockfile fails (simulated)',
        () => {
          arrangeSingleSkillHappyPath(mockFileSystem);
          mockFailWriteFile({
            handle: mockFileSystem,
            absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            message: 'write lockfile failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error saying the skills lockfile could not be written',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not write the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
          ]);
        },
      );

      And(
        'the skills lockfile on disk is not updated and temporary download folders are removed',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
          assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        },
      );
    },
  );

  f.Scenario(
    'After a successful update-all, temporary folders used to download remote skills are removed',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('two managed skills are clean', () => {
        arrangeTwoSkillsHappyPath(mockFileSystem);
      });

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then(
        'there are no leftover temporary folders from the remote downloads',
        () => {
          assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        },
      );
    },
  );

  f.Scenario(
    'Update-all leaves locally edited skills alone, updates the rest, and shows both the good news and the warning',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      let skipped: Record<string, string>;

      Given(
        'note-taker has local edits relative to the lockfile and review-helper is clean',
        () => {
          const r = arrangeOneSkippedOneUpdated(mockFileSystem);
          skipped = r.skippedSkillOnDiskFiles;
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then('the skipped skill directory is left untouched', () => {
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(firstSkillDir, 'SKILL.md'),
          }),
        ).toBe(skipped['SKILL.md']);
      });

      And(
        'I see which skill was updated and a warning about the skipped skill with a hint to use --force',
        () => {
          expect(env.effectStdoutMessages).toEqual([
            [
              'Updated 1 managed skills:',
              `- ${SECOND_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${SECOND_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
              '',
            ].join('\n'),
          ]);
          expect(env.effectStderrMessages).toEqual([
            [
              'Skipped 1 managed skills due to local edits. Re-run with --force to overwrite local changes:',
              `- ${FIRST_SKILL.name} local edits detected in SKILL.md`,
              '',
            ].join('\n'),
          ]);
        },
      );
    },
  );

  f.Scenario(
    'Only skills that actually updated get a new entry on disk; skipped skills keep their previous record',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('one skill is skipped for local edits and one updates', () => {
        arrangeOneSkippedOneUpdated(mockFileSystem);
      });

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then(
        'the saved skills list keeps the skipped skill unchanged and refreshes the one that updated',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(1);
          const saved = JSON.parse(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            }),
          ) as { skills: Record<string, unknown>[] };
          expect(saved.skills).toEqual([
            {
              commit: FIRST_SKILL.originalCommit,
              files: hashFileSet(FIRST_SKILL.localFiles),
              importedAt: SAMPLE_IMPORTED_AT,
              name: FIRST_SKILL.name,
              path: FIRST_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: SAMPLE_IMPORTED_AT,
            },
            {
              commit: FETCHED_COMMIT,
              files: hashFileSet(SECOND_SKILL.remoteFiles),
              importedAt: SAMPLE_IMPORTED_AT,
              name: SECOND_SKILL.name,
              path: SECOND_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: UPDATED_AT,
            },
          ]);
        },
      );
    },
  );

  f.Scenario(
    'When every skill has local edits and I do not pass --force, update-all updates nothing and warns about each skip',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'every managed skill has local edits relative to the lockfile',
        () => {
          arrangeBothSkillsSkippedDueToLocalEdits(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        });
      });

      Then(
        'I see that no skills were updated and a warning listing every skipped skill',
        () => {
          expect(env.effectStdoutMessages).toEqual([
            'No managed skills were updated.\n',
          ]);
          expect(env.effectStderrMessages).toEqual([
            [
              'Skipped 2 managed skills due to local edits. Re-run with --force to overwrite local changes:',
              `- ${FIRST_SKILL.name} local edits detected in SKILL.md`,
              `- ${SECOND_SKILL.name} local edits detected in SKILL.md`,
              '',
            ].join('\n'),
          ]);
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        },
      );
    },
  );

  f.Scenario(
    'Passing --force makes update-all overwrite local edits on every managed skill',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'both skills have local edits that would otherwise be skipped',
        () => {
          arrangeBothSkillsSkippedDueToLocalEdits(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update-all --force`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all', '--force'],
          ...env.cliOptions,
        });
      });

      Then('both directories match their remote snapshots', () => {
        for (const [rel, content] of Object.entries(FIRST_SKILL.remoteFiles)) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(firstSkillDir, rel),
            }),
          ).toBe(content);
        }
        for (const [rel, content] of Object.entries(SECOND_SKILL.remoteFiles)) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(secondSkillDir, rel),
            }),
          ).toBe(content);
        }
      });

      And(
        'the skills lockfile is saved twice and I see no skip warnings',
        () => {
          expect(env.effectStderrMessages).toEqual([]);
          expect(mockFileSystem.lockfileWrites).toHaveLength(2);
        },
      );
    },
  );

  f.Scenario(
    'Update-all stops with an error if it cannot tell whether a skill folder exists while checking for local edits',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'two skills are clean but checking whether the note-taker folder exists fails (simulated)',
        () => {
          arrangeTwoSkillsHappyPath(mockFileSystem);
          mockFailExists({
            handle: mockFileSystem,
            absolutePath: firstSkillDir,
            message: 'exists failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'I see an error that the tool could not tell whether the skill path exists',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not check whether path exists: ${firstSkillDir}\n`,
          ]);
        },
      );

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    'Update-all stops with an error if it cannot list a skill folder while checking for local edits',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'two skills are clean but listing the note-taker folder fails while comparing to the lockfile (simulated)',
        () => {
          arrangeTwoSkillsHappyPath(mockFileSystem);
          mockFailReadDirectory({
            handle: mockFileSystem,
            absolutePath: firstSkillDir,
            message: 'read dir failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update-all`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update-all'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('I see an error that the skill folder could not be scanned', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not scan skill directory: ${firstSkillDir}\n`,
        ]);
      });

      And('the skills lockfile on disk is not updated', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      });
    },
  );

  f.Scenario(
    '`dry-ai skills update-all` rejects a flag the command does not define',
    ({ When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      When('I run update-all with `--bogus`', async () => {
        env = createTestEnv({ mockFileSystem });
        await expect(
          runCLI({
            argv: ['skills', 'update-all', '--bogus'],
            ...env.cliOptions,
            exitOverride: true,
          }),
        ).rejects.toMatchObject({
          code: 'commander.unknownOption',
        });
      });

      Then(
        'the command stops before changing any skills or the skills lockfile',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
          expect(env.effectStdoutMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);
        },
      );
    },
  );

  f.Scenario(
    '`dry-ai skills update-all` rejects extra words after the command name',
    ({ When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      When('I pass a stray positional after update-all', async () => {
        env = createTestEnv({ mockFileSystem });
        await expect(
          runCLI({
            argv: ['skills', 'update-all', 'extra'],
            ...env.cliOptions,
            exitOverride: true,
          }),
        ).rejects.toMatchObject({
          code: 'commander.excessArguments',
        });
      });

      Then(
        'the command stops before changing any skills or the skills lockfile',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
          expect(env.effectStdoutMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);
        },
      );
    },
  );
});
