import os from 'node:os';
import path from 'node:path';

import { defineFeature } from '@amiceli/vitest-cucumber';
import { Effect } from 'effect';
import * as Ref from 'effect/Ref';
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
  mockFailMakeDirectory,
  mockFailReadDirectory,
  mockFailReadFileString,
  mockFailStat,
  seedLocalSkillDirectory,
  storeMockTextFile,
} from '../../helpers.js';

const FIRST_SKILL = {
  name: 'note-taker',
  path: 'skills/note-taker',
  commit: 'abcdef1234567890',
} as const;

const SECOND_SKILL = {
  name: 'review-helper',
  path: 'skills/review-helper',
  commit: '1234567890abcdef',
} as const;

/** Managed skill listed in the lockfile but with no on-disk folder. */
const MISSING_LOCAL_SKILL = {
  name: 'ghost-skill',
  path: 'skills/ghost',
  commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
} as const;

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(),
    tmpdir: vi.fn(),
  },
}));

const mockedOs = vi.mocked(os);

function managedLockfileEntry(skill: {
  readonly name: string;
  readonly path: string;
  readonly commit: string;
}) {
  return {
    name: skill.name,
    repo: SAMPLE_NORMALIZED_REPO,
    path: skill.path,
    commit: skill.commit,
    importedAt: SAMPLE_IMPORTED_AT,
    updatedAt: SAMPLE_IMPORTED_AT,
  };
}

/**
 * Expected `skills list` summary segment for fixtures above — not imported from
 * production code so this file only *acts* on the app via {@link runCLI}.
 */
function expectedManagedSkillSummaryFromFixture(skill: {
  readonly name: string;
  readonly path: string;
  readonly commit: string;
}): string {
  const shortCommit = skill.commit.slice(0, 7);
  return `${skill.name} repo=${SAMPLE_NORMALIZED_REPO} path=${skill.path} ref=HEAD commit=${shortCommit}`;
}

defineFeature('dry-ai skills list', (f) => {
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
    'No skills to show — folder already exists',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the skills source root directory already exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });

        expect(mockFileSystem.directories.has(DEFAULT_SKILLS_SOURCE_ROOT)).toBe(
          true,
        );
      });

      And('there is no skills lockfile on disk', () => {
        expect(mockFileSystem.files.has(DEFAULT_SKILLS_LOCKFILE_PATH)).toBe(
          false,
        );
      });

      When('I run `dry-ai skills list`', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        });
      });

      Then('the command prints that no local skills were found', () => {
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual(['No local skills found.\n']);
      });

      And('the command does not print errors', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'No skills to show when the skills folder did not exist and `dry-ai skills list` creates it',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('my skills folder does not exist yet', () => {
        expect(mockFileSystem.directories.has(DEFAULT_SKILLS_SOURCE_ROOT)).toBe(
          false,
        );
      });

      And('creating it does not fail', () => {
        const failures = Effect.runSync(Ref.get(mockFileSystem.failuresRef));
        expect(failures.makeDirectory.size).toBe(0);
      });

      And('there is no skills lockfile on disk', () => {
        expect(mockFileSystem.files.has(DEFAULT_SKILLS_LOCKFILE_PATH)).toBe(
          false,
        );
      });

      And('there are no local skill folders to list', () => {
        const root = DEFAULT_SKILLS_SOURCE_ROOT;
        const childPrefix = `${root}${path.sep}`;
        expect(
          [...mockFileSystem.directories].every(
            (d) => d !== root && !d.startsWith(childPrefix),
          ),
        ).toBe(true);
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        });
      });

      Then('I see a message that no local skills were found', () => {
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual(['No local skills found.\n']);
      });

      And(
        'the command completes successfully and the skills folder now exists',
        () => {
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);
          expect(
            mockFileSystem.directories.has(DEFAULT_SKILLS_SOURCE_ROOT),
          ).toBe(true);
        },
      );
    },
  );

  f.Scenario(
    'Fails when the skills directory cannot be created',
    ({ Given, When, Then, And }) => {
      let env!: ReturnType<typeof createTestEnv>;

      Given('my skills folder is not there yet', () => {
        expect(mockFileSystem.directories.has(DEFAULT_SKILLS_SOURCE_ROOT)).toBe(
          false,
        );
      });

      And('creating my skills folder fails', () => {
        mockFailMakeDirectory({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_SOURCE_ROOT,
          message: 'permission denied (test)',
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then(
        'the CLI prints that the skills directory could not be created',
        () => {
          expect(env.effectStderrMessages).toEqual([
            `Could not create the skills directory: ${DEFAULT_SKILLS_SOURCE_ROOT}\n`,
          ]);
        },
      );

      And('Commander stays quiet on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Fails when the skills folder cannot be read',
    ({ Given, When, Then, And }) => {
      let env!: ReturnType<typeof createTestEnv>;

      Given('reading entries under my skills folder fails', () => {
        mockFailReadDirectory({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_SOURCE_ROOT,
          message: 'readdir failed (test)',
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that skill folders could not be listed', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not list skill folders under: ${DEFAULT_SKILLS_SOURCE_ROOT}\n`,
        ]);
      });

      And('Commander stays quiet on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Fails when a skill entry cannot be inspected',
    ({ Given, When, Then, And }) => {
      let env!: ReturnType<typeof createTestEnv>;
      const skillPath = path.join(DEFAULT_SKILLS_SOURCE_ROOT, 'my-skill');

      Given('there is at least one folder under my skills directory', () => {
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: 'my-skill',
          files: { 'SKILL.md': 'x' },
        });
      });

      And('inspecting that folder with stat fails', () => {
        mockFailStat({
          handle: mockFileSystem,
          absolutePath: skillPath,
          message: 'stat failed (test)',
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that skill folders could not be listed', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not list skill folders under: ${DEFAULT_SKILLS_SOURCE_ROOT}\n`,
        ]);
      });

      And('Commander stays quiet on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Fails when the skills lockfile presence check errors',
    ({ Given, When, Then, And }) => {
      let env!: ReturnType<typeof createTestEnv>;

      Given('checking whether the skills lockfile exists fails', () => {
        mockFailExists({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'exists failed (test)',
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be checked', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not check the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And('Commander stays quiet on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Fails when the skills lockfile cannot be read',
    ({ Given, When, Then, And }) => {
      let env!: ReturnType<typeof createTestEnv>;

      Given('the skills lockfile is present', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [],
          }),
        });
      });

      And('reading the skills lockfile fails', () => {
        mockFailReadFileString({
          handle: mockFileSystem,
          absolutePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          message: 'read failed (test)',
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints that the lockfile could not be read', () => {
        expect(env.effectStderrMessages).toEqual([
          `Could not read the skills lockfile: ${DEFAULT_SKILLS_LOCKFILE_PATH}\n`,
        ]);
      });

      And('Commander stays quiet on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Fails when the skills lockfile is not valid JSON',
    ({ Given, When, Then, And }) => {
      let env!: ReturnType<typeof createTestEnv>;
      const message = `Could not parse the skills lockfile (${DEFAULT_SKILLS_LOCKFILE_PATH}). Fix JSON/schema errors in that file.`;

      Given('the skills lockfile is not valid JSON', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: '{"version":1,"skills":[}',
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        }).catch(() => undefined);
      });

      Then('the CLI prints a parse error for the skills lockfile', () => {
        expect(env.effectStderrMessages).toEqual([`${message}\n`]);
      });

      And('Commander stays quiet on stderr', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.cmderStdoutMessages).toEqual([]);
        expect(env.effectStdoutMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Shows managed skill summaries for lockfile-backed folders',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the skills source root already exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });
      });

      And('two managed skills exist locally in sorted order', () => {
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: FIRST_SKILL.name,
          files: { 'SKILL.md': 'a' },
        });
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: SECOND_SKILL.name,
          files: { 'SKILL.md': 'b' },
        });
      });

      And('the lockfile lists those skills', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              managedLockfileEntry(SECOND_SKILL),
              managedLockfileEntry(FIRST_SKILL),
            ],
          }),
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        });
      });

      Then('the command prints a line for each managed skill', () => {
        const firstLine = `- ${expectedManagedSkillSummaryFromFixture(FIRST_SKILL)}`;
        const secondLine = `- ${expectedManagedSkillSummaryFromFixture(SECOND_SKILL)}`;
        expect(env.effectStdoutMessages).toEqual([
          `${firstLine}\n${secondLine}\n`,
        ]);
      });

      And('the command does not print errors', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Marks a local folder as unmanaged when it is not in the lockfile',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the skills source root already exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });
      });

      And('a local skill folder is not listed in the lockfile', () => {
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: 'side-project',
          files: { 'SKILL.md': 'x' },
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [managedLockfileEntry(FIRST_SKILL)],
          }),
        });
        seedLocalSkillDirectory({
          handle: mockFileSystem,
          skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
          skillName: FIRST_SKILL.name,
          files: { 'SKILL.md': 'y' },
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        });
      });

      Then('the output tags the extra folder as unmanaged', () => {
        const managedLine = `- ${expectedManagedSkillSummaryFromFixture(FIRST_SKILL)}`;
        expect(env.effectStdoutMessages).toEqual([
          `${managedLine}\n- side-project unmanaged\n`,
        ]);
      });

      And('the command does not print errors', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Lists managed, unmanaged, and missing-on-disk skills in one run',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the skills source root already exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });
      });

      And(
        'local folders exist for a managed skill and for a name not in the lockfile',
        () => {
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: FIRST_SKILL.name,
            files: { 'SKILL.md': 'a' },
          });
          seedLocalSkillDirectory({
            handle: mockFileSystem,
            skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
            skillName: 'side-project',
            files: { 'SKILL.md': 'x' },
          });
        },
      );

      And(
        'the lockfile lists the managed skill and another skill with no local folder',
        () => {
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
            content: JSON.stringify({
              version: 1,
              skills: [
                managedLockfileEntry(FIRST_SKILL),
                managedLockfileEntry(MISSING_LOCAL_SKILL),
              ],
            }),
          });
        },
      );

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        });
      });

      Then(
        'the output includes a managed line, an unmanaged line, and a missing-local line',
        () => {
          const managedLine = `- ${expectedManagedSkillSummaryFromFixture(FIRST_SKILL)}`;
          const missingLine = `- ${expectedManagedSkillSummaryFromFixture(MISSING_LOCAL_SKILL)} missing-local-directory`;
          expect(env.effectStdoutMessages).toEqual([
            `${managedLine}\n- side-project unmanaged\n${missingLine}\n`,
          ]);
        },
      );

      And('the command does not print errors', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );

  f.Scenario(
    'Marks managed skills missing on disk',
    ({ Given, When, Then, And }) => {
      let env: ReturnType<typeof createTestEnv>;

      Given('the skills source root already exists', () => {
        ensureMockDirectory({
          handle: mockFileSystem,
          directoryPath: DEFAULT_SKILLS_SOURCE_ROOT,
        });
      });

      And('the lockfile lists a skill with no local folder', () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [managedLockfileEntry(MISSING_LOCAL_SKILL)],
          }),
        });
      });

      When('I run skills list', async () => {
        env = createTestEnv({ mockFileSystem });
        await runCLI({
          argv: ['skills', 'list'],
          ...env.cliOptions,
        });
      });

      Then('the output says the managed skill is missing locally', () => {
        const line = `- ${expectedManagedSkillSummaryFromFixture(MISSING_LOCAL_SKILL)} missing-local-directory`;
        expect(env.effectStdoutMessages).toEqual([`${line}\n`]);
      });

      And('the command does not print errors', () => {
        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);
      });
    },
  );
});
