import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  seedLocalSkillDirectory,
  storeMockTextFile,
} from '../../helpers.ts';

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

// `vi.mocked` is a pure type helper: it returns the mocked default export but
// types each method as `MockedFunction<typeof fs.method>`, so
// `.mockResolvedValue` / `.mockReturnValue` calls are checked against the real
// module signatures without any explicit casts.
const mockedOs = vi.mocked(os);

/**
 * Specs for `dry-ai skills remove` via {@link runCLI} (full CLI → Commander →
 * `runSkillsRemoveCommand`).
 */
describe('dry-ai skills remove', () => {
  let mockFileSystem: MockFileSystemHandle;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem({
      handle: mockFileSystem,
      lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    });
    configureMockOs({
      mockedOs: mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });
  });

  describe('happy paths', () => {
    describe('basic remove', () => {
      it('removes a managed skill directory from disk and deletes its lockfile entry', async () => {
        // Arrange: seed two managed skills (both on disk AND in the lockfile)
        // so the removal of `REMOVED_SKILL` has an observable effect on both
        // the filesystem and the lockfile, while `KEPT_SKILL` can act as a
        // negative control for "leaves other entries untouched".
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

        const keptSkillLockfileEntry = {
          commit: KEPT_SKILL.commit,
          files: { 'SKILL.md': 'b'.repeat(64) },
          importedAt: SAMPLE_IMPORTED_AT,
          name: KEPT_SKILL.name,
          path: KEPT_SKILL.path,
          repo: SAMPLE_NORMALIZED_REPO,
          updatedAt: SAMPLE_IMPORTED_AT,
        };
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: JSON.stringify({
            version: 1,
            skills: [
              {
                commit: REMOVED_SKILL.commit,
                files: { 'SKILL.md': 'a'.repeat(64) },
                importedAt: SAMPLE_IMPORTED_AT,
                name: REMOVED_SKILL.name,
                path: REMOVED_SKILL.path,
                repo: SAMPLE_NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
              keptSkillLockfileEntry,
            ],
          }),
        });

        const environment = createTestEnv({ mockFileSystem });
        const removedSkillDir = path.join(
          DEFAULT_SKILLS_SOURCE_ROOT,
          REMOVED_SKILL.name,
        );
        const keptSkillDir = path.join(
          DEFAULT_SKILLS_SOURCE_ROOT,
          KEPT_SKILL.name,
        );

        // Act
        await runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...environment.cliOptions,
        });

        // Assert: the removed skill's directory (and every file under it) is
        // gone from the mock filesystem; the kept skill's directory is intact.
        expect(mockFileSystem.directories.has(removedSkillDir)).toBe(false);
        for (const relativeFilePath of Object.keys(REMOVED_SKILL.files)) {
          expect(
            mockFileSystem.files.has(
              path.join(removedSkillDir, relativeFilePath),
            ),
          ).toBe(false);
        }
        expect(mockFileSystem.directories.has(keptSkillDir)).toBe(true);
        for (const relativeFilePath of Object.keys(KEPT_SKILL.files)) {
          expect(
            mockFileSystem.files.has(path.join(keptSkillDir, relativeFilePath)),
          ).toBe(true);
        }

        // Assert: the lockfile was saved exactly once, and the persisted
        // contents contain only the kept skill.
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);
        expect(JSON.parse(mockFileSystem.lockfileWrites[0] ?? '')).toEqual({
          version: 1,
          skills: [keptSkillLockfileEntry],
        });

        // Assert: stdout reports the removed skill's summary; stderr is empty.
        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          `Removed ${REMOVED_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${REMOVED_SKILL.path} ref=HEAD commit=${REMOVED_SKILL.commit.slice(0, 7)}\n`,
        ]);
      });
    });

    describe('partial on-disk state', () => {
      // priority: med — real-world drift (manual deletes); ensures lockfile still updates.
      it.todo(
        'removes the lockfile entry even when the on-disk skill directory is already missing',
      );
    });
  });

  describe('sad paths', () => {
    it('throws Managed skill not found when the name is absent from a non-empty lockfile', async () => {
      // Arrange: lockfile lists only KEPT_SKILL; REMOVED_SKILL is not managed.
      storeMockTextFile({
        handle: mockFileSystem,
        filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
        content: JSON.stringify({
          version: 1,
          skills: [
            {
              commit: KEPT_SKILL.commit,
              files: { 'SKILL.md': 'b'.repeat(64) },
              importedAt: SAMPLE_IMPORTED_AT,
              name: KEPT_SKILL.name,
              path: KEPT_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: SAMPLE_IMPORTED_AT,
            },
          ],
        }),
      });

      const environment = createTestEnv({ mockFileSystem });

      // Act
      await expect(
        runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...environment.cliOptions,
        }),
      ).rejects.toThrow(
        `No managed skill named "${REMOVED_SKILL.name}" is listed in the skills lockfile. Try \`skills list\`.`,
      );

      // Assert
      expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      expect(environment.stdoutMessages).toEqual([]);
    });

    it('throws Managed skill not found when no lockfile exists on disk yet', async () => {
      // Arrange: `loadSkillsLockfile` treats a missing file as an empty lockfile.
      const environment = createTestEnv({ mockFileSystem });

      // Act
      await expect(
        runCLI({
          argv: ['skills', 'remove', REMOVED_SKILL.name],
          ...environment.cliOptions,
        }),
      ).rejects.toThrow(
        `No managed skill named "${REMOVED_SKILL.name}" is listed in the skills lockfile. Try \`skills list\`.`,
      );

      // Assert
      expect(mockFileSystem.lockfileWrites).toHaveLength(0);
      expect(environment.stdoutMessages).toEqual([]);
    });

    it.each([
      {
        description: 'unsupported lockfile version',
        lockfileText: JSON.stringify({ version: 2, skills: [] }),
      },
      {
        description: 'duplicate managed skill name',
        lockfileText: JSON.stringify({
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
      },
      {
        description: 'malformed JSON',
        lockfileText: '{"version":1,"skills":[}',
      },
    ] as const)(
      'throws InvalidSkillsLockfile when lockfile has $description',
      async ({ lockfileText }) => {
        // Arrange
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: DEFAULT_SKILLS_LOCKFILE_PATH,
          content: lockfileText,
        });
        const environment = createTestEnv({ mockFileSystem });

        // Act
        await expect(
          runCLI({
            argv: ['skills', 'remove', REMOVED_SKILL.name],
            ...environment.cliOptions,
          }),
        ).rejects.toThrow(
          `Could not parse the skills lockfile (${DEFAULT_SKILLS_LOCKFILE_PATH}). Fix JSON/schema errors in that file.`,
        );

        // Assert
        expect(mockFileSystem.lockfileWrites).toHaveLength(0);
        expect(environment.stdoutMessages).toEqual([]);
      },
    );

    // priority: med — removal uses FS; failures must surface instead of a misleading success path.
    // TODO(cli-user-message): when implemented, assert RemovePathError / RemoveManagedSkillDirectoryError curated lines (present-error.ts).
    it.todo(
      'propagates filesystem errors thrown while removing the skill directory',
    );
  });
});
