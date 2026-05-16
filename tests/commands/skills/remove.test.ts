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
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
  ensureMockDirectory,
  mockFailExists,
  mockFailReadFileString,
  mockFailRemove,
  mockFailWriteFile,
  seedLocalSkillDirectory,
  storeMockTextFile,
} from '../../helpers.js';

const REMOVED_SKILL = {
  name: 'note-taker',
  path: 'skills/note-taker',
  commit: 'abcdef1234567890',
  files: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker\n',
    'rules.md': '# rules\n',
  },
} as const;

const KEPT_SKILL = {
  name: 'review-helper',
  path: 'skills/review-helper',
  commit: '1234567890abcdef',
  files: {
    'SKILL.md': '---\nname: review-helper\n---\n\n# Review helper\n',
  },
} as const;

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(),
    tmpdir: vi.fn(),
  },
}));

const mockedOs = vi.mocked(os);

function removedSkillLockfileEntry() {
  return {
    commit: REMOVED_SKILL.commit,
    files: { 'SKILL.md': 'a'.repeat(64) },
    importedAt: SAMPLE_IMPORTED_AT,
    name: REMOVED_SKILL.name,
    path: REMOVED_SKILL.path,
    repo: SAMPLE_NORMALIZED_REPO,
    updatedAt: SAMPLE_IMPORTED_AT,
  };
}

function keptSkillLockfileEntry() {
  return {
    commit: KEPT_SKILL.commit,
    files: { 'SKILL.md': 'b'.repeat(64) },
    importedAt: SAMPLE_IMPORTED_AT,
    name: KEPT_SKILL.name,
    path: KEPT_SKILL.path,
    repo: SAMPLE_NORMALIZED_REPO,
    updatedAt: SAMPLE_IMPORTED_AT,
  };
}

function expectedRemovedStdoutLine(): string {
  const short = REMOVED_SKILL.commit.slice(0, 7);
  return `Removed ${REMOVED_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${REMOVED_SKILL.path} ref=HEAD commit=${short}\n`;
}

const managedSkillNotFoundLine = `No managed skill named "${REMOVED_SKILL.name}" is listed in the skills lockfile. Try \`skills list\`.\n`;

const invalidLockfileLine = `Could not parse the skills lockfile (${DEFAULT_SKILLS_LOCKFILE_PATH}). Fix JSON/schema errors in that file.\n`;

defineFeature('dry-ai skills remove', (f) => {
  let mockFileSystem: MockFileSystemHandle;

  f.BeforeEachScenario(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem({
      handle: mockFileSystem,
      lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    });

    configureMockOs({
      mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });
  });

  f.Scenario(
    'Remove succeeds when the skill is on disk and another managed skill stays',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      const removedSkillDir = path.join(
        DEFAULT_SKILLS_SOURCE_ROOT,
        REMOVED_SKILL.name,
      );
      const keptSkillDir = path.join(
        DEFAULT_SKILLS_SOURCE_ROOT,
        KEPT_SKILL.name,
      );
      const kept = keptSkillLockfileEntry();

      Given('the skills source root exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });
      });

      And('the lockfile lists the removed skill and a kept skill', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [removedSkillLockfileEntry(), kept],
          }),
        });
      });

      And('both skills have local directories', () => {
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: REMOVED_SKILL.name,
          files: REMOVED_SKILL.files,
        });
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: KEPT_SKILL.name,
          files: KEPT_SKILL.files,
        });
      });

      When('I run `dry-ai skills remove` for the removed skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('the removed skill directory and its files are gone', () => {
        expect(mockFileSystem.directories.has(removedSkillDir)).toBe(false);
        for (const relativeFilePath of Object.keys(REMOVED_SKILL.files)) {
          expect(
            mockFileSystem.files.has(
              path.join(removedSkillDir, relativeFilePath),
            ),
          ).toBe(false);
        }
      });

      And('the kept skill directory and files remain', () => {
        expect(mockFileSystem.directories.has(keptSkillDir)).toBe(true);
        for (const relativeFilePath of Object.keys(KEPT_SKILL.files)) {
          expect(
            mockFileSystem.files.has(path.join(keptSkillDir, relativeFilePath)),
          ).toBe(true);
        }
      });

      And('the lockfile is saved once with only the kept skill', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        expect(JSON.parse(mockFileSystem.lockfileWrites[0] ?? '')).toEqual({
          version: 1,
          skills: [kept],
        });
      });

      And('the CLI logs removal and stays clean on Commander streams', () => {
        expect(env.effectStdoutMessages).toEqual([expectedRemovedStdoutLine()]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove succeeds when the managed skill directory is already missing on disk',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the skills source root exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });
      });

      And('the lockfile lists only the removed skill', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [removedSkillLockfileEntry()],
          }),
        });
      });

      And('there is no local directory for that skill', () => {
        expect(
          mockFileSystem.directories.has(
            path.join(DEFAULT_SKILLS_SOURCE_ROOT, REMOVED_SKILL.name),
          ),
        ).toBe(false);
      });

      When('I run `dry-ai skills remove` for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        });
      });

      Then('the lockfile is updated with an empty skills list', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        expect(JSON.parse(mockFileSystem.lockfileWrites[0] ?? '')).toEqual({
          version: 1,
          skills: [],
        });
      });

      And('the CLI logs removal without errors', () => {
        expect(env.effectStdoutMessages).toEqual([expectedRemovedStdoutLine()]);
        expect(env.effectStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove reports not managed when no lockfile file exists yet',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('there is no skills lockfile on disk', () => {
        expect(mockFileSystem.files.has(DEFAULT_SKILLS_LOCKFILE_PATH)).toBe(
          false,
        );
      });

      When('I run `dry-ai skills remove` for the skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the skill is not in the lockfile', () => {
        expect(env.effectStderrMessages).toEqual([managedSkillNotFoundLine]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove reports not managed when the lockfile omits this skill name',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('a valid lockfile lists a different managed skill only', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [keptSkillLockfileEntry()],
          }),
        });
      });

      When(
        'I run `dry-ai skills remove` for a name not in the lockfile',
        async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({
            argv: ['skills', 'remove', REMOVED_SKILL.name],
            ...env.cliOptions,
          }).catch(() => undefined);
        },
      );

      Then('the CLI prints that the skill is not listed', () => {
        expect(env.effectStderrMessages).toEqual([managedSkillNotFoundLine]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove fails when checking whether the lockfile exists fails',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('exists for the lockfile path is mocked to fail', () => {
        mockFailExists({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'exists failed (test)',
        });
      });

      When('I run dry-ai skills remove', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be checked', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not check the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove fails when the lockfile cannot be read',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('a lockfile file exists with valid JSON', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [removedSkillLockfileEntry()],
          }),
        });
      });

      And('reading that file is mocked to fail', () => {
        mockFailReadFileString({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'read failed (test)',
        });
      });

      When('I run `dry-ai skills remove`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be read', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not read the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove fails when the lockfile is not valid JSON',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile contents are malformed JSON', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: '{"version":1,"skills":[}',
        });
      });

      When('I run `dry-ai skills remove`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove fails when the lockfile has an unsupported version',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile JSON has an unsupported version field', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({ version: 2, skills: [] }),
        });
      });

      When('I run `dry-ai skills remove`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove fails when the lockfile lists duplicate managed skill names',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the lockfile JSON has two entries with the same name', () => {
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
      });

      When('I run `dry-ai skills remove`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([invalidLockfileLine]);
      });

      And('no lockfile write occurred', () => {
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(env.effectStdoutMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.cmderStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Remove fails when the lockfile cannot be written',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      const removedSkillDir = path.join(
        DEFAULT_SKILLS_SOURCE_ROOT,
        REMOVED_SKILL.name,
      );

      Given(
        'the removed skill exists on disk and in a valid lockfile with a kept skill',
        () => {
          ensureMockDirectory({
            handle: mockFileSystem,
            directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
          });
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: REMOVED_SKILL.name,
            files: REMOVED_SKILL.files,
          });
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: KEPT_SKILL.name,
            files: KEPT_SKILL.files,
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [removedSkillLockfileEntry(), keptSkillLockfileEntry()],
            }),
          });
        },
      );

      And('writing the lockfile path is mocked to fail', () => {
        mockFailWriteFile({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'write failed (test)',
        });
      });

      When('I run `dry-ai skills remove` for the removed skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be written', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not write the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And(
        'the skill directory still exists and no lockfile write was recorded',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(0);
          expect(mockFileSystem.directories.has(removedSkillDir)).toBe(true);
          expect(env.effectStdoutMessages).toEqual([]);
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
        },
      );
    },
  );

  f.Scenario(
    'Remove fails when deleting the skill directory fails after the lockfile saved',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;
      const removedSkillDir = path.join(
        DEFAULT_SKILLS_SOURCE_ROOT,
        REMOVED_SKILL.name,
      );

      Given(
        'the removed skill exists on disk and is the only lockfile entry',
        () => {
          ensureMockDirectory({
            handle: mockFileSystem,
            directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
          });
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: REMOVED_SKILL.name,
            files: REMOVED_SKILL.files,
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [removedSkillLockfileEntry()],
            }),
          });
        },
      );

      And('removing that directory is mocked to fail', () => {
        mockFailRemove({
          handle: mockFileSystem,
          absolutePath: removedSkillDir,
          message: 'remove failed (test)',
        });
      });

      When('I run dry-ai skills remove for that skill', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the CLI prints that the skill directory could not be removed',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not remove skill directory: ${removedSkillDir}\n`,
          ]);
        },
      );

      And(
        'the lockfile was saved without that skill but files remain on disk',
        () => {
          expect(mockFileSystem.lockfileWrites).toHaveLength(1);
          expect(JSON.parse(mockFileSystem.lockfileWrites[0] ?? '')).toEqual({
            version: 1,
            skills: [],
          });
          expect(mockFileSystem.directories.has(removedSkillDir)).toBe(true);
          for (const relativeFilePath of Object.keys(REMOVED_SKILL.files)) {
            expect(
              mockFileSystem.files.has(
                path.join(removedSkillDir, relativeFilePath),
              ),
            ).toBe(true);
          }
          expect(env.effectStdoutMessages).toEqual([]);
          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
        },
      );
    },
  );
});
