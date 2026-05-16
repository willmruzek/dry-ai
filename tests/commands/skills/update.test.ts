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
  mockFailMakeDirectory,
  mockFailReadDirectory,
  mockFailReadFileBytes,
  mockFailReadFileString,
  mockFailRemove,
  mockFailWriteFile,
  normalizeMockPath,
  readMockTextFile,
  seedLocalSkillDirectory,
  seedRemoteSkillCheckout,
  storeMockTextFile,
} from '../../helpers.js';

const UPDATED_AT = '2026-05-01T12:00:00.000Z';
const FETCHED_COMMIT = 'fedcba9876543210';

/** Pinned git ref (40-char) stored on the lockfile when imported with `--pin`. */
const PINNED_REF = 'feedfacefeedfacefeedfacefeedfacefeedface';

const OTHER_SKILL = {
  name: 'review-helper',
  path: 'skills/review-helper',
  files: {
    'SKILL.md': '---\nname: review-helper\n---\n\n# Review helper\n',
  },
} as const;

const OTHER_SKILL_ORIGINAL_COMMIT = '1111111111111111111111111111111111111111';

const TARGET_SKILL = {
  name: 'note-taker',
  path: 'skills/note-taker',
  originalCommit: 'abcdef1234567890',
  localFiles: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (old)\n',
    'legacy.md': '# legacy doc\n',
  },
  remoteFiles: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (new)\n',
    'rules.md': '# new rules\n',
  },
} as const;

/** Remote tree with a nested file so post-replace hashing walks into `sub/`. */
const REMOTE_FILES_WITH_SUBDIR = {
  ...TARGET_SKILL.remoteFiles,
  'sub/nested.md': 'nested\n',
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

const mockedOs = vi.mocked(os);
const mockedGit = createMockedGit();

const invalidLockfileLine = `Could not parse the skills lockfile (${DEFAULT_SKILLS_LOCKFILE_PATH}). Fix JSON/schema errors in that file.\n`;

const managedSkillNotFoundLine = `No managed skill named "${TARGET_SKILL.name}" is listed in the skills lockfile. Try \`skills list\`.\n`;

const skillTargetDir = normalizeMockPath(
  path.join(DEFAULT_SKILLS_SOURCE_ROOT, TARGET_SKILL.name),
);

const skillRulesPath = path.join(skillTargetDir, 'rules.md');

const skillSubDir = path.join(skillTargetDir, 'sub');

const agentsSkillTempPrefix = normalizeMockPath(
  path.join('/virtual/tmp', 'agents-skill.'),
);

function expectedUpdatedStdoutLine(options?: { ref?: string }): string {
  const refLabel = options?.ref ?? 'HEAD';
  return `Updated ${TARGET_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${TARGET_SKILL.path} ref=${refLabel} commit=${FETCHED_COMMIT.slice(0, 7)}\n`;
}

function noteTakerLockfileSkillEntry(extra?: {
  ref?: string;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    commit: TARGET_SKILL.originalCommit,
    files: hashFileSet(TARGET_SKILL.localFiles),
    importedAt: SAMPLE_IMPORTED_AT,
    name: TARGET_SKILL.name,
    path: TARGET_SKILL.path,
    repo: SAMPLE_NORMALIZED_REPO,
    updatedAt: SAMPLE_IMPORTED_AT,
  };
  if (extra?.ref !== undefined) {
    entry.ref = extra.ref;
  }
  return entry;
}

function otherSkillLockfileSkillEntry(): Record<string, unknown> {
  return {
    commit: OTHER_SKILL_ORIGINAL_COMMIT,
    files: hashFileSet(OTHER_SKILL.files),
    importedAt: SAMPLE_IMPORTED_AT,
    name: OTHER_SKILL.name,
    path: OTHER_SKILL.path,
    repo: SAMPLE_NORMALIZED_REPO,
    updatedAt: SAMPLE_IMPORTED_AT,
  };
}

function arrangeTwoSkillsOnDiskWithLockfile(
  handle: MockFileSystemHandle,
): void {
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: TARGET_SKILL.name,
    files: TARGET_SKILL.localFiles,
  });
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: OTHER_SKILL.name,
    files: OTHER_SKILL.files,
  });
  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: JSON.stringify({
      version: 1,
      skills: [noteTakerLockfileSkillEntry(), otherSkillLockfileSkillEntry()],
    }),
  });
}

function arrangeLockfileForNoteTakerButNoLocalSkillDir(
  handle: MockFileSystemHandle,
): void {
  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: JSON.stringify({
      version: 1,
      skills: [noteTakerLockfileSkillEntry()],
    }),
  });
}

function arrangeHappyPathUpdate(handle: MockFileSystemHandle): void {
  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: TARGET_SKILL.name,
    files: TARGET_SKILL.localFiles,
  });
  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: JSON.stringify({
      version: 1,
      skills: [noteTakerLockfileSkillEntry()],
    }),
  });
}

function arrangeSkillWithLocalEdits(handle: MockFileSystemHandle): {
  onDiskFiles: Record<string, string>;
} {
  const onDiskFiles = {
    ...TARGET_SKILL.localFiles,
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (user edit)\n',
  };

  seedLocalSkillDirectory({
    handle,
    skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
    skillName: TARGET_SKILL.name,
    files: onDiskFiles,
  });
  storeMockTextFile({
    handle,
    filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    content: JSON.stringify({
      version: 1,
      skills: [noteTakerLockfileSkillEntry()],
    }),
  });

  return { onDiskFiles };
}

function assertNoAgentsSkillCheckoutDirs(handle: MockFileSystemHandle): void {
  expect(
    [...handle.directories].filter((d) =>
      path.basename(d).startsWith('agents-skill.'),
    ),
  ).toEqual([]);
}

defineFeature('dry-ai skills update', (f) => {
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
        seedRemoteSkillCheckout({
          handle: mockFileSystem,
          checkoutDir: repoRoot,
          skillPath: TARGET_SKILL.path,
          files: TARGET_SKILL.remoteFiles,
        });
      },
    });
    mockedGit.fetch.mockClear();
    mockedGit.init.mockClear();
    mockedGit.addRemote.mockClear();
    mockedGit.checkout.mockClear();
    mockedGit.revparse.mockClear();

    configureMockOs({
      mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
  });

  f.AfterEachScenario(() => {
    vi.useRealTimers();
  });

  f.Scenario(
    'Update writes every remote file into the local skill directory with the remote bytes',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker and on-disk note-taker files match the lockfile hashes',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then(
        'each remote file is on disk with the same bytes as the snapshot',
        () => {
          for (const [relativeFilePath, content] of Object.entries(
            TARGET_SKILL.remoteFiles,
          )) {
            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(skillTargetDir, relativeFilePath),
              }),
            ).toBe(content);
          }
        },
      );
    },
  );

  f.Scenario(
    'Update swaps in the remote tree so paths missing from remote are deleted (lockfile still matched disk first)',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker on disk matches the lockfile hashes and includes legacy.md, which the seeded remote checkout does not',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then(
        'legacy.md is removed because the fetched remote tree has no such file',
        () => {
          expect(
            mockFileSystem.files.has(path.join(skillTargetDir, 'legacy.md')),
          ).toBe(false);
        },
      );
    },
  );

  f.Scenario(
    'Update refreshes the lockfile entry with the fetched commit and file hashes',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker and on-disk note-taker files match the lockfile hashes',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then(
        'the lockfile was saved once with refreshed commit and hashes',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(1);
          expect(
            JSON.parse(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
              }),
            ),
          ).toEqual({
            version: 1,
            skills: [
              {
                commit: FETCHED_COMMIT,
                files: hashFileSet(TARGET_SKILL.remoteFiles),
                importedAt: SAMPLE_IMPORTED_AT,
                name: TARGET_SKILL.name,
                path: TARGET_SKILL.path,
                repo: SAMPLE_NORMALIZED_REPO,
                updatedAt: UPDATED_AT,
              },
            ],
          });
        },
      );
    },
  );

  f.Scenario(
    'Successful update prints a single Updated summary and no error output',
    ({ Given, When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker and on-disk note-taker files match the lockfile hashes',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then(
        'exactly one Updated summary line is emitted and no error lines appear',
        () => {
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);
          expect(env.effectStdoutMessages).toEqual([
            expectedUpdatedStdoutLine(),
          ]);
        },
      );
    },
  );

  f.Scenario(
    'Update skips when local edits differ from the lockfile snapshot and no `--force` is passed',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      let onDiskFiles: Record<string, string>;

      Given(
        'note-taker SKILL.md on disk no longer matches the hashes stored in the lockfile entry',
        () => {
          onDiskFiles = arrangeSkillWithLocalEdits(mockFileSystem).onDiskFiles;
        },
      );

      When('I run `dry-ai skills update` without `--force`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('on-disk files are unchanged and the lockfile is not saved', () => {
        for (const [relativeFilePath, content] of Object.entries(onDiskFiles)) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(skillTargetDir, relativeFilePath),
            }),
          ).toBe(content);
        }
        expect(mockFileSystem.lockfileWrites).toEqual([]);
      });

      And(
        'no success summary is printed and only the local-edit skip warning appears',
        () => {
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStdoutMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([
            `Skipped ${TARGET_SKILL.name} because local edits were detected in: SKILL.md. Re-run with --force to overwrite local changes.\n`,
          ]);
        },
      );
    },
  );

  f.Scenario(
    'Update with `--force` overwrites local edits and refreshes the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker SKILL.md on disk no longer matches the hashes stored in the lockfile entry',
        () => {
          arrangeSkillWithLocalEdits(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update --force`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name, '--force'],
          ...env.cliOptions,
        });
      });

      Then(
        'disk matches the remote snapshot and legacy-only files are removed',
        () => {
          for (const [relativeFilePath, content] of Object.entries(
            TARGET_SKILL.remoteFiles,
          )) {
            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(skillTargetDir, relativeFilePath),
              }),
            ).toBe(content);
          }
          expect(
            mockFileSystem.files.has(path.join(skillTargetDir, 'legacy.md')),
          ).toBe(false);
        },
      );

      And('the lockfile records the fetched commit and hashes once', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        expect(
          JSON.parse(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            }),
          ),
        ).toEqual({
          version: 1,
          skills: [
            {
              commit: FETCHED_COMMIT,
              files: hashFileSet(TARGET_SKILL.remoteFiles),
              importedAt: SAMPLE_IMPORTED_AT,
              name: TARGET_SKILL.name,
              path: TARGET_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: UPDATED_AT,
            },
          ],
        });
      });

      And(
        'only the Updated success line appears and nothing that reads as an error',
        () => {
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);
          expect(env.effectStdoutMessages).toEqual([
            expectedUpdatedStdoutLine(),
          ]);
        },
      );
    },
  );

  f.Scenario(
    'Update fails when the skill name is not listed in the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile lists a different managed skill only', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              {
                commit: '1234567890abcdef1234567890abcdef12345678',
                files: { 'SKILL.md': 'b'.repeat(64) },
                importedAt: SAMPLE_IMPORTED_AT,
                name: 'other-skill',
                path: 'skills/other',
                repo: SAMPLE_NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
            ],
          }),
        });
      });

      When('I run `dry-ai skills update` for the missing name', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints the managed-skill not-found line', () => {
        expect(env.effectStderrMessages).toEqual([managedSkillNotFoundLine]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when checking whether the lockfile exists fails',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('exists for the lockfile path is mocked to fail', () => {
        mockFailExists({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'exists failed (test)',
        });
      });

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be checked', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not check the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the lockfile cannot be read',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('a lockfile exists but reading it is mocked to fail', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              {
                commit: TARGET_SKILL.originalCommit,
                files: hashFileSet(TARGET_SKILL.localFiles),
                importedAt: SAMPLE_IMPORTED_AT,
                name: TARGET_SKILL.name,
                path: TARGET_SKILL.path,
                repo: SAMPLE_NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
            ],
          }),
        });
        mockFailReadFileString({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'read failed (test)',
        });
      });

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be read', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not read the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the lockfile is malformed JSON',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile contents are not valid JSON', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: '{"version":1,"skills":[}',
        });
      });

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the lockfile version is unsupported',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile JSON declares an unsupported version', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({ version: 2, skills: [] }),
        });
      });

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the lockfile lists duplicate managed skill names',
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

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the run cannot tell whether the skill folder exists',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files and FileSystem.exists on the skill directory is mocked to fail',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailExists({
            handle: mockFileSystem,
            absolutePath: skillTargetDir,
            message: 'exists failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the run reports that it could not check whether the skill path exists',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not check whether path exists: ${skillTargetDir}\n`,
          ]);
        },
      );

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the skill folder cannot be listed',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files and FileSystem.readDirectory on the skill directory is mocked to fail',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailReadDirectory({
            handle: mockFileSystem,
            absolutePath: skillTargetDir,
            message: 'read dir failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the run reports that the skill folder could not be scanned', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not scan skill directory: ${skillTargetDir}\n`,
        ]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when SKILL.md cannot be read while checking it against the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      const skillMdPath = path.join(skillTargetDir, 'SKILL.md');

      Given(
        'the lockfile lists note-taker with matching on-disk files and FileSystem.readFile on SKILL.md is mocked to fail',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailReadFileBytes({
            handle: mockFileSystem,
            absolutePath: skillMdPath,
            message: 'read file failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the run reports that SKILL.md could not be read under the skill folder',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not read file while hashing skill content: ${skillMdPath}\n`,
          ]);
        },
      );

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the skills lockfile cannot be written after a successful replace',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'fetch and replace would succeed for note-taker but FileSystem.writeFile on the skills lockfile is mocked to fail',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailWriteFile({
            handle: mockFileSystem,
            absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            message: 'write failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the CLI prints that the skills lockfile could not be written',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not write the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
          ]);
        },
      );

      And(
        'the remote clone checkout is cleaned up despite the save failure',
        () => {
          assertNoAgentsSkillCheckoutDirs(mockFileSystem);
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
          expect(env.effectStdoutMessages).toEqual([]);
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
        },
      );
    },
  );

  f.Scenario(
    'Update fails when creating the temporary clone directory fails',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files and FileSystem.makeTempDirectory for the agents-skill clone prefix is mocked to fail',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailMakeDirectory({
            handle: mockFileSystem,
            absolutePath: agentsSkillTempPrefix,
            message: 'mkdtemp failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the CLI reports that a temporary directory for cloning could not be created',
        () => {
          expect(env.effectStderrMessages).toEqual([
            'Could not create a temporary directory for cloning (prefix agents-skill.).\n',
          ]);
        },
      );

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the mocked git remote operation rejects',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files and git fetch in the clone step is mocked to reject',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockedGit.fetch.mockRejectedValueOnce(
            new Error('git fetch failed (test)'),
          );
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints the git remote operation error message', () => {
        expect(env.effectStderrMessages).toEqual([
          `Failed to fetch repository from ${SAMPLE_NORMALIZED_REPO}\n`,
        ]);
      });

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when the remote snapshot is missing SKILL.md',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files and the mocked checkout has only rules.md under skills/note-taker (no SKILL.md)',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
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
                skillPath: TARGET_SKILL.path,
                files: { 'rules.md': '# incomplete remote\n' },
              });
            },
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'one line explains that the skill could not be fetched from the repository',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Failed to fetch skill from ${SAMPLE_NORMALIZED_REPO}\n`,
          ]);
        },
      );

      And('no lockfile write occurs', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when replacing the managed skill directory fails',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files and FileSystem.remove on the skill directory is mocked to fail during replace',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailRemove({
            handle: mockFileSystem,
            absolutePath: skillTargetDir,
            message: 'remove staging failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the run reports that skill files could not be installed into the skill folder',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not install skill files into: ${skillTargetDir}\n`,
          ]);
        },
      );

      And('no lockfile write occurs and the clone is cleaned up', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when a new subfolder from the remote cannot be listed after install',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files, the mocked remote adds skills/note-taker/sub/nested.md, and FileSystem.readDirectory on that subfolder is mocked to fail after install',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
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
                skillPath: TARGET_SKILL.path,
                files: REMOTE_FILES_WITH_SUBDIR,
              });
            },
          });
          mockFailReadDirectory({
            handle: mockFileSystem,
            absolutePath: skillSubDir,
            message: 'read subdir failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the run reports that a folder under the skill path could not be scanned',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not scan skill directory: ${skillSubDir}\n`,
          ]);
        },
      );

      And('no lockfile write occurs and the clone is cleaned up', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update fails when rules.md added by the update cannot be read while refreshing the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker with matching on-disk files, the remote adds rules.md on update, and FileSystem.readFile on rules.md under the skill directory is mocked to fail during hashing',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
          mockFailReadFileBytes({
            handle: mockFileSystem,
            absolutePath: skillRulesPath,
            message: 'read rules failed (test)',
          });
        },
      );

      When('I run `dry-ai skills update`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the run reports that rules.md could not be read under the skill folder',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not read file while hashing skill content: ${skillRulesPath}\n`,
          ]);
        },
      );

      And('no lockfile write occurs and the clone is cleaned up', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'After a successful update, temporary remote clone directories are removed',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker and on-disk note-taker files match the lockfile hashes',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then(
        'no agents-skill temporary checkout directory remains on the mock filesystem',
        () => {
          assertNoAgentsSkillCheckoutDirs(mockFileSystem);
        },
      );

      And('the update completed with one lockfile save', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Updating one managed skill leaves all other lockfile entries unchanged',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      const otherBefore = otherSkillLockfileSkillEntry();

      Given(
        'two managed skills exist on disk and both are listed in the lockfile',
        () => {
          arrangeTwoSkillsOnDiskWithLockfile(mockFileSystem);
        },
      );

      When('I run `dry-ai skills update` only for note-taker', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then(
        'the review-helper lockfile entry is byte-for-byte what it was before',
        () => {
          const saved = JSON.parse(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            }),
          ) as { skills: Record<string, unknown>[] };
          const otherAfter = saved.skills.find(
            (s) => s.name === OTHER_SKILL.name,
          );
          expect(otherAfter).toEqual(otherBefore);
        },
      );

      And('note-taker was refreshed in the same saved lockfile', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: Record<string, unknown>[] };
        const nt = saved.skills.find((s) => s.name === TARGET_SKILL.name);
        expect(nt?.commit).toBe(FETCHED_COMMIT);
        expect(nt?.updatedAt).toBe(UPDATED_AT);
      });
    },
  );

  f.Scenario(
    'Update still refreshes commit and updatedAt when remote file bytes already match local',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker on disk matches the lockfile hashes and the mocked remote checkout has the same file bytes',
        () => {
          arrangeHappyPathUpdate(mockFileSystem);
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
                skillPath: TARGET_SKILL.path,
                files: { ...TARGET_SKILL.localFiles },
              });
            },
          });
          mockedGit.fetch.mockClear();
          mockedGit.init.mockClear();
          mockedGit.addRemote.mockClear();
          mockedGit.checkout.mockClear();
          mockedGit.revparse.mockClear();
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('on-disk file bytes are unchanged from before the run', () => {
        for (const [relativeFilePath, content] of Object.entries(
          TARGET_SKILL.localFiles,
        )) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(skillTargetDir, relativeFilePath),
            }),
          ).toBe(content);
        }
      });

      And('the lockfile shows the new fetched commit and updatedAt', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: Record<string, unknown>[] };
        expect(saved.skills[0]).toMatchObject({
          commit: FETCHED_COMMIT,
          files: hashFileSet(TARGET_SKILL.localFiles),
          updatedAt: UPDATED_AT,
        });
      });
    },
  );

  f.Scenario(
    'Update installs from remote when the local skill directory is missing but the lockfile lists the skill',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'the lockfile lists note-taker and there is no local note-taker directory yet',
        () => {
          arrangeLockfileForNoteTakerButNoLocalSkillDir(mockFileSystem);
          expect(mockFileSystem.directories.has(skillTargetDir)).toBe(false);
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('the skill directory contains the remote files', () => {
        for (const [relativeFilePath, content] of Object.entries(
          TARGET_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(skillTargetDir, relativeFilePath),
            }),
          ).toBe(content);
        }
      });

      And('the lockfile is saved with the fetched commit', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Update uses the pinned revision saved on the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker is on disk and the lockfile entry includes a pinned ref',
        () => {
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: TARGET_SKILL.name,
            files: TARGET_SKILL.localFiles,
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [noteTakerLockfileSkillEntry({ ref: PINNED_REF })],
            }),
          });
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('the remote checkout requested that pinned revision', () => {
        expect(mockedGit.fetch).toHaveBeenCalledWith('origin', PINNED_REF, [
          '--depth',
          '1',
        ]);
      });

      And('the success line shows that ref and the resolved commit', () => {
        expect(env.effectStdoutMessages).toEqual([
          expectedUpdatedStdoutLine({ ref: PINNED_REF }),
        ]);
      });
    },
  );

  f.Scenario(
    'Update refreshes from the branch named on the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given(
        'note-taker is on disk and the lockfile entry tracks ref main',
        () => {
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: TARGET_SKILL.name,
            files: TARGET_SKILL.localFiles,
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [noteTakerLockfileSkillEntry({ ref: 'main' })],
            }),
          });
        },
      );

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('the remote checkout requested branch main', () => {
        expect(mockedGit.fetch).toHaveBeenCalledWith('origin', 'main', [
          '--depth',
          '1',
        ]);
      });

      And('the lockfile still names main with the new commit', () => {
        const saved = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ) as { skills: { ref?: string; commit: string }[] };
        expect(saved.skills[0].ref).toBe('main');
        expect(saved.skills[0].commit).toBe(FETCHED_COMMIT);
      });
    },
  );

  f.Scenario(
    'Update uses the remote default when the lockfile does not name a ref',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('note-taker is on disk and the lockfile entry omits ref', () => {
        arrangeHappyPathUpdate(mockFileSystem);
      });

      When('I run `dry-ai skills update` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('the remote checkout requests the default revision (HEAD)', () => {
        expect(mockedGit.fetch).toHaveBeenCalledWith('origin', 'HEAD', [
          '--depth',
          '1',
        ]);
      });

      And('the success line shows HEAD as the ref label', () => {
        expect(env.effectStdoutMessages).toEqual([expectedUpdatedStdoutLine()]);
      });
    },
  );

  f.Scenario(
    '`dry-ai skills update` without a skill name is not accepted',
    ({ When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      When('I run `dry-ai skills update` with no name argument', async () => {
        env = createTestEnv({ mockFileSystem });
        await expect(
          runCLI({
            argv: ['skills', 'update'],
            ...env.cliOptions,
            exitOverride: true,
          }),
        ).rejects.toMatchObject({
          code: 'commander.missingArgument',
        });
      });

      Then('no managed-skill effects ran', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    '`dry-ai skills update` rejects an unknown flag',
    ({ When, Then }) => {
      let env: ReturnType<typeof createTestEnv>;

      When('I run update with `--bogus`', async () => {
        env = createTestEnv({ mockFileSystem });
        await expect(
          runCLI({
            argv: ['skills', 'update', TARGET_SKILL.name, '--bogus'],
            ...env.cliOptions,
            exitOverride: true,
          }),
        ).rejects.toMatchObject({
          code: 'commander.unknownOption',
        });
      });

      Then('no managed-skill effects ran', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );
});
