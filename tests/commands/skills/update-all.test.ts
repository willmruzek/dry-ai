import os from 'node:os';
import path from 'node:path';

import fsExtra from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCLI } from '../../../src/cli.js';

import {
  DEFAULT_SKILLS_LOCKFILE_PATH,
  DEFAULT_SKILLS_SOURCE_ROOT,
  type MockFileSystemState,
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
 * Seeds every managed skill's remote-source fixture files into one freshly
 * cloned checkout directory. `fetchRemoteSkillSnapshot` only reads the path
 * matching the current skill, so seeding both is cheap and keeps the
 * `onMkdtemp` callback uniform across the two clones performed per run.
 */
function seedAllRemoteSkills(
  state: MockFileSystemState,
  checkoutDir: string,
): void {
  for (const skill of [FIRST_SKILL, SECOND_SKILL]) {
    seedRemoteSkillCheckout(state, checkoutDir, skill.path, skill.remoteFiles);
  }
}

describe('dry-ai skills update-all', () => {
  let mockFileSystem: MockFileSystemState;

  /**
   * Arranges the "one-skipped, one-updated" scenario used by the
   * `local edits without --force` test group:
   *
   *   - `FIRST_SKILL`: on-disk content differs from the hashes stored in the
   *     lockfile, so `detectLocalSkillEdits` returns `modified: true` and
   *     `update-all` skips it (no `--force`).
   *   - `SECOND_SKILL`: on-disk content matches its lockfile hashes, so it
   *     proceeds through the full clone → replace → rehash update path.
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

    seedLocalSkillDirectory(
      mockFileSystem,
      DEFAULT_SKILLS_SOURCE_ROOT,
      FIRST_SKILL.name,
      skippedSkillOnDiskFiles,
    );
    seedLocalSkillDirectory(
      mockFileSystem,
      DEFAULT_SKILLS_SOURCE_ROOT,
      SECOND_SKILL.name,
      SECOND_SKILL.localFiles,
    );

    // The lockfile stores hashes of `FIRST_SKILL.localFiles` (the pre-edit
    // baseline); comparing those against the hashes of the actual on-disk
    // bytes (`skippedSkillOnDiskFiles`) yields `modified: true` with
    // `changedFiles: ['SKILL.md']`.
    storeMockTextFile(
      mockFileSystem,
      DEFAULT_SKILLS_LOCKFILE_PATH,
      JSON.stringify({
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
    );

    return { skippedSkillOnDiskFiles };
  }

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem(mockFileSystem, mockedFs, {
      lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
      onMkdtemp: (state, tempDir, prefix) => {
        // Two distinct `mkdtemp` callsites fire during update-all:
        //   1. `cloneRemoteRepo` → prefix basename `agents-skill.` (seed it).
        //   2. `replaceManagedSkillDirectory` → prefix basename
        //      `<skillName>.` under the skills source root (leave empty).
        if (path.basename(prefix).startsWith('agents-skill.')) {
          seedAllRemoteSkills(state, tempDir);
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
        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          FIRST_SKILL.name,
          FIRST_SKILL.localFiles,
        );
        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          SECOND_SKILL.name,
          SECOND_SKILL.localFiles,
        );

        storeMockTextFile(
          mockFileSystem,
          DEFAULT_SKILLS_LOCKFILE_PATH,
          JSON.stringify({
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
        );

        const environment = createTestEnv();

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

        // Assert: the lockfile was saved exactly once (update-all
        // accumulates per-skill updates in memory and persists them in a
        // single write at the end of the run).
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);

        const savedLockfile = JSON.parse(
          readMockTextFile(mockFileSystem, DEFAULT_SKILLS_LOCKFILE_PATH),
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
            readMockTextFile(
              mockFileSystem,
              path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                FIRST_SKILL.name,
                relativeFilePath,
              ),
            ),
          ).toBe(content);
        }
        for (const [relativeFilePath, content] of Object.entries(
          SECOND_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile(
              mockFileSystem,
              path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                SECOND_SKILL.name,
                relativeFilePath,
              ),
            ),
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

      // priority: med
      it.todo(
        'prints a multi-line summary that includes the count and each updated skill',
      );

      // priority: med
      it.todo(
        'prints "No managed skills to update." and exits cleanly when the lockfile is empty',
      );

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
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        // Assert: `FIRST_SKILL`'s on-disk directory still holds the user's
        // edit verbatim — a skip must never overwrite local content.
        expect(
          readMockTextFile(
            mockFileSystem,
            path.join(DEFAULT_SKILLS_SOURCE_ROOT, FIRST_SKILL.name, 'SKILL.md'),
          ),
        ).toBe(skippedSkillOnDiskFiles['SKILL.md']);

        // Assert: `SECOND_SKILL`'s directory was fully replaced with the
        // remote snapshot (every remote file present with the remote
        // bytes), proving the loop continued past the skipped skill.
        for (const [relativeFilePath, content] of Object.entries(
          SECOND_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile(
              mockFileSystem,
              path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                SECOND_SKILL.name,
                relativeFilePath,
              ),
            ),
          ).toBe(content);
        }
      });

      it('reports updated skills on stdout and skipped skills on stderr in the same invocation', async () => {
        // Arrange: one skill with local edits (must be skipped) and one
        // clean skill (must be updated).
        arrangeOneSkippedOneUpdated();
        const environment = createTestEnv();

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
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update-all'],
          ...environment.cliOptions,
        });

        // Assert: per-skill updates accumulate in memory and persist in a
        // single write at the end of the run.
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);

        // Assert: the saved lockfile preserves `FIRST_SKILL`'s entry
        // byte-identically (original commit, original hashes, original
        // `importedAt`/`updatedAt`) while `SECOND_SKILL`'s entry is
        // refreshed with the fetched commit, new remote-file hashes, and a
        // new `updatedAt`.
        const savedLockfile = JSON.parse(
          readMockTextFile(mockFileSystem, DEFAULT_SKILLS_LOCKFILE_PATH),
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

      // priority: med
      it.todo(
        'prints "No managed skills were updated." when every managed skill was skipped due to local edits',
      );
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
