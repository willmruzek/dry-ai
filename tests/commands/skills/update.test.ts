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
// Returned by the mocked `git revparse ['HEAD']`, so the updated lockfile
// entry's `commit` moves to this value.
const FETCHED_COMMIT = 'fedcba9876543210';

const TARGET_SKILL = {
  name: 'note-taker',
  path: 'skills/note-taker',
  originalCommit: 'abcdef1234567890',
  // On-disk bytes whose hashes match the lockfile entry exactly, so
  // `detectLocalSkillEdits` returns `modified: false` and the update
  // proceeds through the full fetch → replace → rehash pipeline.
  localFiles: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (old)\n',
    // Present locally but absent remotely — the replacement must delete
    // this old-only file so `replaceManagedSkillDirectory` is observably
    // doing a full swap, not an overlay.
    'legacy.md': '# legacy doc\n',
  },
  // Remote content differs from `localFiles` and adds `rules.md`, so a
  // successful replace produces all three observable effects: a changed
  // file, a new file, and a removed file.
  remoteFiles: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (new)\n',
    'rules.md': '# new rules\n',
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

const mockedFs = vi.mocked(fsExtra);
const mockedOs = vi.mocked(os);
const mockedGit = createMockedGit();

describe('dry-ai skills update', () => {
  let mockFileSystem: MockFileSystemState;

  /**
   * Arranges the happy-path preconditions shared by every test under
   * `describe('happy path')`:
   *
   *   - Seeds `TARGET_SKILL` on disk with `localFiles` (includes `legacy.md`,
   *     a local-only file the remote snapshot does not contain).
   *   - Seeds the lockfile with a single entry whose `files` hashes exactly
   *     match `localFiles`, so `detectLocalSkillEdits` returns
   *     `modified: false` and the update runs end-to-end (no `--force`).
   */
  function arrangeHappyPathUpdate(): void {
    seedLocalSkillDirectory(
      mockFileSystem,
      DEFAULT_SKILLS_SOURCE_ROOT,
      TARGET_SKILL.name,
      TARGET_SKILL.localFiles,
    );
    storeMockTextFile(
      mockFileSystem,
      DEFAULT_SKILLS_LOCKFILE_PATH,
      JSON.stringify({
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
    );
  }

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem(mockFileSystem, mockedFs, {
      lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
      onMkdtemp: (state, tempDir, prefix) => {
        // Two distinct `mkdtemp` callsites fire during update:
        //   1. `cloneRemoteRepo` → prefix basename `agents-skill.` (seed it).
        //   2. `replaceManagedSkillDirectory` → prefix basename
        //      `<skillName>.` under the skills source root (leave empty).
        if (path.basename(prefix).startsWith('agents-skill.')) {
          seedRemoteSkillCheckout(
            state,
            tempDir,
            TARGET_SKILL.path,
            TARGET_SKILL.remoteFiles,
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
    vi.setSystemTime(new Date(UPDATED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy paths', () => {
    describe('basic update', () => {
      it('writes the fetched remote files into the local skill directory with the remote bytes', async () => {
        // Arrange: seed the local skill + matching lockfile entry.
        arrangeHappyPathUpdate();
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: every remote file is now on disk with the remote bytes
        // (covers both "same path, new content" and "new path not in
        // localFiles", since `TARGET_SKILL.remoteFiles` includes both).
        for (const [relativeFilePath, content] of Object.entries(
          TARGET_SKILL.remoteFiles,
        )) {
          expect(
            readMockTextFile(
              mockFileSystem,
              path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                TARGET_SKILL.name,
                relativeFilePath,
              ),
            ),
          ).toBe(content);
        }
      });

      it('removes files that exist only locally so the replacement is a full directory swap', async () => {
        // Arrange: seed the local skill (which includes `legacy.md`,
        // absent from the remote snapshot) + matching lockfile entry.
        arrangeHappyPathUpdate();
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: `legacy.md` is gone — if `replaceManagedSkillDirectory`
        // ever regressed to an overlay copy (instead of swapping the
        // whole directory), this file would stick around and this
        // assertion is what would catch it.
        expect(
          mockFileSystem.files.has(
            path.join(
              DEFAULT_SKILLS_SOURCE_ROOT,
              TARGET_SKILL.name,
              'legacy.md',
            ),
          ),
        ).toBe(false);
      });

      it('updates the lockfile entry with the fetched commit and remote file hashes while preserving importedAt', async () => {
        // Arrange: seed the local skill + matching lockfile entry.
        arrangeHappyPathUpdate();
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: the lockfile was saved exactly once.
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);

        // Assert: the saved entry is refreshed (new commit, new file
        // hashes, new `updatedAt`) while `importedAt` is preserved from
        // the original import.
        const savedLockfile = JSON.parse(
          readMockTextFile(mockFileSystem, DEFAULT_SKILLS_LOCKFILE_PATH),
        ) as unknown;
        expect(savedLockfile).toEqual({
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

      it('prints the updated skill summary to stdout and keeps stderr empty', async () => {
        // Arrange: seed the local skill + matching lockfile entry.
        arrangeHappyPathUpdate();
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: the "Updated <summary>" `logInfo` line lands on stdout.
        expect(environment.stdoutMessages).toEqual([
          `Updated ${TARGET_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${TARGET_SKILL.path} ref=HEAD commit=${FETCHED_COMMIT.slice(0, 7)}\n`,
        ]);

        // Assert: stderr stays empty on a successful update (no warnings).
        expect(environment.stderrMessages).toEqual([]);
      });

      // priority: med
      it.todo(
        'cleans up the temporary remote-snapshot directory after a successful update',
      );

      // priority: med
      it.todo(
        'leaves other managed skill entries in the lockfile untouched',
      );
    });

    describe('no-op updates', () => {
      // priority: low
      it.todo(
        'still runs the replace+rehash pipeline and bumps updatedAt when the remote contents are byte-identical to the local copy',
      );

      // priority: med
      it.todo(
        'proceeds with the update when the local skill directory is missing entirely (detectLocalSkillEdits returns not-modified)',
      );
    });

    describe('local edits without --force', () => {
      /**
       * Arranges the "local edits detected" skip scenario:
       *
       *   - On disk: `SKILL.md` holds user-edited bytes, while every
       *     other file from `TARGET_SKILL.localFiles` (e.g. `legacy.md`)
       *     is seeded with its baseline bytes so only `SKILL.md` shows as
       *     changed.
       *   - Lockfile: entry's `files` hashes match the PRE-edit baseline
       *     (`TARGET_SKILL.localFiles`), so `detectLocalSkillEdits`
       *     compares baseline-hashes to on-disk-edited-hashes and returns
       *     `modified: true` with `changedFiles: ['SKILL.md']`.
       *
       * Returns the on-disk file set (including the edited `SKILL.md`) so
       * tests can assert the user's content survives the run unchanged.
       */
      function arrangeSkillWithLocalEdits(): {
        onDiskFiles: Record<string, string>;
      } {
        const onDiskFiles = {
          ...TARGET_SKILL.localFiles,
          'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (user edit)\n',
        };

        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          TARGET_SKILL.name,
          onDiskFiles,
        );
        storeMockTextFile(
          mockFileSystem,
          DEFAULT_SKILLS_LOCKFILE_PATH,
          JSON.stringify({
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
        );

        return { onDiskFiles };
      }

      it('skips updating the skill when local edits are detected', async () => {
        // Arrange: on-disk `SKILL.md` bytes differ from lockfile hashes.
        const { onDiskFiles } = arrangeSkillWithLocalEdits();
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: every seeded on-disk file still holds its pre-run
        // bytes — `SKILL.md` keeps the user's edit and unchanged files
        // (e.g. `legacy.md`) are not touched either. A skip must never
        // modify local content.
        for (const [relativeFilePath, content] of Object.entries(
          onDiskFiles,
        )) {
          expect(
            readMockTextFile(
              mockFileSystem,
              path.join(
                DEFAULT_SKILLS_SOURCE_ROOT,
                TARGET_SKILL.name,
                relativeFilePath,
              ),
            ),
          ).toBe(content);
        }

        // Assert: the lockfile was never saved — the skip short-circuits
        // before any lockfile mutation, so the persisted entry stays
        // byte-identical to what the user had before the run.
        expect(mockFileSystem.lockfileWrites).toEqual([]);
      });

      it('warns on stderr with the user-edited files and a hint to use --force', async () => {
        // Arrange: on-disk `SKILL.md` bytes differ from lockfile hashes.
        arrangeSkillWithLocalEdits();
        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'update', TARGET_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: a single `logWarn` payload names the skill, lists the
        // changed file(s), and hints at `--force` — these three pieces
        // together are what tells the user what went wrong AND how to
        // proceed.
        expect(environment.stderrMessages).toEqual([
          `Skipped ${TARGET_SKILL.name} because local edits were detected in: SKILL.md. Re-run with --force to overwrite local changes.\n`,
        ]);
      });

      // priority: med
      it.todo('does not fetch the remote snapshot when skipping');

      // priority: low
      it.todo('keeps stdout empty when skipping due to local edits');
    });

    describe('local edits with --force', () => {
      // priority: med
      it.todo(
        'overwrites local edits with the fetched remote copy when --force is passed',
      );

      // priority: med
      it.todo(
        'updates the lockfile hashes to match the newly installed remote files when --force is passed',
      );
    });

    describe('pinned skills', () => {
      // priority: med
      it.todo(
        'fetches the pinned commit from the lockfile ref when the skill was imported with --pin',
      );

      // priority: med
      it.todo(
        'tracks the moving ref stored in the lockfile when the skill was imported without --pin',
      );

      // priority: med
      it.todo(
        'uses the remote default ("HEAD") when the lockfile entry has no ref field',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills update" without a <name> positional argument with a commander.missingArgument error',
    );

    // priority: low
    it.todo(
      'rejects "dry-ai skills update" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: med
    it.todo('throws when the skill name is not present in the lockfile');

    // priority: med
    it.todo(
      'cleans up the temporary remote-snapshot directory even when a fetch or copy error is thrown mid-update',
    );

    // priority: med
    it.todo(
      'propagates network errors thrown by the remote fetch step without mutating the lockfile',
    );

    // priority: med
    it.todo(
      'does not mutate the lockfile when an error is thrown before the save step',
    );

    // priority: low
    it.todo(
      'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
    );
  });
});
