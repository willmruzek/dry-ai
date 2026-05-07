import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  mockFailRemove,
  readMockTextFile,
  seedLocalSkillDirectory,
  seedRemoteSkillCheckout,
  storeMockTextFile,
} from '../../helpers.js';

const UPDATED_AT = '2026-05-01T12:00:00.000Z';
// Returned by the mocked `git revparse ['HEAD']` for every clone, so both
// skills end up at the same fresh commit after update-all.
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
 * Seeds every managed skill's remote-source fixture files into one freshly
 * cloned checkout directory. `fetchRemoteSkillSnapshot` only reads the path
 * matching the current skill, so seeding both is cheap and keeps the
 * `checkoutImplementation` hook uniform across the two clones performed per run.
 */
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

describe('dry-ai skills update-all', () => {
  let mockFileSystem: MockFileSystemHandle;

  /**
   * Arranges the "one-skipped, one-updated" scenario used by the
   * `local edits without --force` test group:
   *
   *   - `FIRST_SKILL`: on-disk content differs from the hashes stored in the
   *     lockfile, so `detectLocalSkillEdits` returns `modified: true` and
   *     `update-all` skips it (no `--force`).
   *   - `SECOND_SKILL`: on-disk content matches its lockfile hashes, so it
   *     proceeds through the full clone → replace → hash update path.
   *
   * Returns the exact bytes seeded onto `FIRST_SKILL`'s disk so tests can
   * assert the locally-edited content survives the run unchanged.
   */
  function arrangeOneSkippedOneUpdated(): {
    skippedSkillOnDiskFiles: Record<string, string>;
  } {
    const skippedSkillOnDiskFiles = {
      'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (user edit)\n',
    } as const;

    seedLocalSkillDirectory({
      handle: mockFileSystem,
      skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
      skillName: FIRST_SKILL.name,
      files: skippedSkillOnDiskFiles,
    });
    seedLocalSkillDirectory({
      handle: mockFileSystem,
      skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
      skillName: SECOND_SKILL.name,
      files: SECOND_SKILL.localFiles,
    });

    // The lockfile stores hashes of `FIRST_SKILL.localFiles` (the pre-edit
    // baseline); comparing those against the hashes of the actual on-disk
    // bytes (`skippedSkillOnDiskFiles`) yields `modified: true` with
    // `changedFiles: ['SKILL.md']`.
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
      content: JSON.stringify({
        version: 1,
        skills: [
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
        ],
      }),
    });

    return { skippedSkillOnDiskFiles };
  }

  /**
   * Both managed skills have on-disk edits relative to the lockfile baseline,
   * so `update-all` without `--force` skips every skill (`updatedLines` empty).
   */
  function arrangeBothSkillsSkippedDueToLocalEdits(): void {
    seedLocalSkillDirectory({
      handle: mockFileSystem,
      skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
      skillName: FIRST_SKILL.name,
      files: {
        'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (user edit)\n',
      },
    });
    seedLocalSkillDirectory({
      handle: mockFileSystem,
      skillsSourceRoot: DEFAULT_SKILLS_SOURCE_ROOT,
      skillName: SECOND_SKILL.name,
      files: {
        ...SECOND_SKILL.localFiles,
        'SKILL.md':
          '---\nname: review-helper\n---\n\n# Review helper (user edit)\n',
      },
    });

    storeMockTextFile({
      handle: mockFileSystem,
      filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
      content: JSON.stringify({
        version: 1,
        skills: [
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
        ],
      }),
    });
  }

  beforeEach(() => {
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
      mockedOs: mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(UPDATED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy paths', () => {
    describe('basic update-all', () => {
      it('updates every managed skill in the lockfile and saves the refreshed lockfile once', async () => {
        // Arrange: seed two managed skills whose local on-disk hashes exactly
        // match what's in the lockfile, so `detectLocalSkillEdits` returns
        // `modified: false` and both skills proceed through the full update
        // path (no --force required, no skips).
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
          content: JSON.stringify({
            version: 1,
            skills: [
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
            ],
          }),
        });

        const environment = createTestEnv({ mockFileSystem });

        // Act
        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        // Assert: one stdout logInfo payload with the count + per-skill
        // summary lines (lockfile-iteration order, which is alphabetical
        // since the lockfile was seeded alphabetically).
        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          [
            'Updated 2 managed skills:',
            `- ${FIRST_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${FIRST_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
            `- ${SECOND_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${SECOND_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
            '',
          ].join('\n'),
        ]);

        // Assert: the lockfile is saved after each successful skill update
        // so partial runs stay consistent with disk.
        expect(mockFileSystem.lockfileWrites).toHaveLength(2);

        const savedLockfile = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ) as unknown;
        expect(savedLockfile).toEqual({
          version: 1,
          skills: [
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
          ],
        });

        // Assert: every local skill directory now contains the fresh
        // remote content, and old-only files (present locally but absent
        // remotely) were removed as part of the full-directory
        // replacement.
        for (const [relativeFilePath, content] of Object.entries(
          FIRST_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                FIRST_SKILL.name,
                relativeFilePath,
              ),
            }),
          ).toBe(content);
        }
        for (const [relativeFilePath, content] of Object.entries(
          SECOND_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                SECOND_SKILL.name,
                relativeFilePath,
              ),
            }),
          ).toBe(content);
        }
        expect(
          mockFileSystem.files.has(
            path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              SECOND_SKILL.name,
              'guides/checklist.md',
            ),
          ),
        ).toBe(false);
      });

      it('persists lockfile after the first skill when the second replace fails mid-filesystem swap', async () => {
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
          content: JSON.stringify({
            version: 1,
            skills: [
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
            ],
          }),
        });

        mockFailRemove({
          handle: mockFileSystem,
          absolutePath: path.join(
            DEFAULT_SKILLS_SOURCE_ROOT,
            SECOND_SKILL.name,
          ),
          message: 'simulated second-skill replace failure',
        });

        const environment = createTestEnv({ mockFileSystem });

        await expect(
          runCLI({
            argv: ['skills', 'update-all'],
            ...environment.cliOptions,
          }),
        ).rejects.toThrow('simulated second-skill replace failure');

        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        const persistedPayload = mockFileSystem.lockfileWrites[0];
        expect(persistedPayload).toBeDefined();

        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ).toBe(persistedPayload);

        const persisted = JSON.parse(persistedPayload) as {
          version: number;
          skills: {
            name: string;
            commit: string;
            files: Record<string, string>;
            updatedAt: string;
          }[];
        };

        expect(persisted.skills).toHaveLength(2);
        expect(persisted.skills[0]).toEqual({
          commit: FETCHED_COMMIT,
          files: hashFileSet(FIRST_SKILL.remoteFiles),
          importedAt: SAMPLE_IMPORTED_AT,
          name: FIRST_SKILL.name,
          path: FIRST_SKILL.path,
          repo: SAMPLE_NORMALIZED_REPO,
          updatedAt: UPDATED_AT,
        });
        expect(persisted.skills[1]).toEqual({
          commit: SECOND_SKILL.originalCommit,
          files: hashFileSet(SECOND_SKILL.localFiles),
          importedAt: SAMPLE_IMPORTED_AT,
          name: SECOND_SKILL.name,
          path: SECOND_SKILL.path,
          repo: SAMPLE_NORMALIZED_REPO,
          updatedAt: SAMPLE_IMPORTED_AT,
        });

        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              FIRST_SKILL.name,
              'SKILL.md',
            ),
          }),
        ).toBe(FIRST_SKILL.remoteFiles['SKILL.md']);
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              SECOND_SKILL.name,
              'SKILL.md',
            ),
          }),
        ).toBe(SECOND_SKILL.localFiles['SKILL.md']);
      });

      it('prints "No managed skills to update." and exits cleanly when the lockfile has no entries', async () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({ version: 1, skills: [] }),
        });
        const environment = createTestEnv({ mockFileSystem });

        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          'No managed skills to update.\n',
        ]);
        expect(mockFileSystem.lockfileWrites).toEqual([]);
      });

      // priority: med
      it.todo(
        'cleans up every temporary remote-snapshot directory after a successful run',
      );

      // priority: low
      it.todo('updates a single-entry lockfile and reports a count of 1');

      // priority: low
      it.todo(
        'keeps stderr empty when every managed skill updates successfully',
      );
    });

    describe('iteration order', () => {
      // priority: low
      it.todo(
        'iterates managed skills in lockfile order and preserves that order in the stdout summary',
      );
    });

    describe('no-op updates', () => {
      // priority: med
      it.todo(
        'proceeds with the update for skills whose local directory is missing entirely (detectLocalSkillEdits returns not-modified)',
      );
    });

    describe('local edits without --force', () => {
      it('skips managed skills with local edits and continues updating the remaining ones', async () => {
        // Arrange: one skill with local edits (must be skipped) and one
        // clean skill (must be updated).
        const { skippedSkillOnDiskFiles } = arrangeOneSkippedOneUpdated();
        const environment = createTestEnv({ mockFileSystem });

        // Act
        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        // Assert: `FIRST_SKILL`'s on-disk directory still holds the user's
        // edit verbatim — a skip must never overwrite local content.
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              FIRST_SKILL.name,
              'SKILL.md',
            ),
          }),
        ).toBe(skippedSkillOnDiskFiles['SKILL.md']);

        // Assert: `SECOND_SKILL`'s directory was fully replaced with the
        // remote snapshot (every remote file present with the remote
        // bytes), proving the loop continued past the skipped skill.
        for (const [relativeFilePath, content] of Object.entries(
          SECOND_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                SECOND_SKILL.name,
                relativeFilePath,
              ),
            }),
          ).toBe(content);
        }
      });

      it('reports updated skills on stdout and skipped skills on stderr in the same invocation', async () => {
        // Arrange: one skill with local edits (must be skipped) and one
        // clean skill (must be updated).
        arrangeOneSkippedOneUpdated();
        const environment = createTestEnv({ mockFileSystem });

        // Act
        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        // Assert: stdout has one `logInfo` payload naming only the updated
        // skill.
        expect(environment.stdoutMessages).toEqual([
          [
            'Updated 1 managed skills:',
            `- ${SECOND_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${SECOND_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}`,
            '',
          ].join('\n'),
        ]);

        // Assert: stderr has one combined `logWarn` payload (single
        // "Skipped N…" preamble followed by one "- <name> local edits
        // detected in <files>" line per skipped skill) naming only the
        // skipped skill.
        expect(environment.stderrMessages).toEqual([
          [
            'Skipped 1 managed skills due to local edits. Re-run with --force to overwrite local changes:',
            `- ${FIRST_SKILL.name} local edits detected in SKILL.md`,
            '',
          ].join('\n'),
        ]);
      });

      it('saves the lockfile containing refreshed entries for updated skills and unchanged entries for skipped skills', async () => {
        // Arrange: one skill with local edits (must be skipped) and one
        // clean skill (must be updated).
        arrangeOneSkippedOneUpdated();
        const environment = createTestEnv({ mockFileSystem });

        // Act
        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        // Assert: only the skill that was updated triggers a lockfile write.
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);

        // Assert: the saved lockfile preserves `FIRST_SKILL`'s entry
        // byte-identically (original commit, original hashes, original
        // `importedAt`/`updatedAt`) while `SECOND_SKILL`'s entry is
        // refreshed with the fetched commit, new remote-file hashes, and a
        // new `updatedAt`.
        const savedLockfile = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ) as unknown;
        expect(savedLockfile).toEqual({
          version: 1,
          skills: [
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
          ],
        });
      });

      it('prints "No managed skills were updated." on stdout when every skill was skipped due to local edits', async () => {
        arrangeBothSkillsSkippedDueToLocalEdits();
        const environment = createTestEnv({ mockFileSystem });

        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        expect(environment.stdoutMessages).toEqual([
          'No managed skills were updated.\n',
        ]);
        expect(environment.stderrMessages).toEqual([
          [
            'Skipped 2 managed skills due to local edits. Re-run with --force to overwrite local changes:',
            `- ${FIRST_SKILL.name} local edits detected in SKILL.md`,
            `- ${SECOND_SKILL.name} local edits detected in SKILL.md`,
            '',
          ].join('\n'),
        ]);

        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        const savedLockfile = JSON.parse(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          }),
        ) as unknown;
        expect(savedLockfile).toEqual({
          version: 1,
          skills: [
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
          ],
        });
      });
    });

    describe('local edits with --force', () => {
      // priority: med
      it.todo(
        'overwrites local edits on every managed skill when --force is passed',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills update-all" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: med
    it.todo(
      'cleans up temporary remote-snapshot directories even when one skill update throws mid-loop',
    );

    // priority: low
    it.todo(
      'continues updating subsequent skills after a non-fatal warning on one skill',
    );

    // priority: med
    it.todo(
      'propagates a fatal error from one skill update and stops processing subsequent skills',
    );

    // priority: low
    it.todo(
      'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
    );
  });
});
