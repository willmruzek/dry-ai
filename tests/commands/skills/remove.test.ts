import os from 'node:os';
import path from 'node:path';

import fsExtra from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCLI } from '../../../src/cli.js';

import {
  DEFAULT_SKILLS_LOCKFILE_PATH,
  DEFAULT_SKILLS_SOURCE_ROOT,
  type MockFileSystemState,
  SAMPLE_IMPORTED_AT,
  SAMPLE_NORMALIZED_REPO,
  VIRTUAL_HOME_DIR,
  configureMockFileSystem,
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
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

describe('dry-ai skills remove', () => {
  let mockFileSystem: MockFileSystemState;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();

    configureMockFileSystem(mockFileSystem, mockedFs, {
      lockfilePath: DEFAULT_SKILLS_LOCKFILE_PATH,
    });
    configureMockOs(mockedOs, {
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
        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          REMOVED_SKILL.name,
          REMOVED_SKILL.files,
        );
        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          KEPT_SKILL.name,
          KEPT_SKILL.files,
        );

        const keptSkillLockfileEntry = {
          commit: KEPT_SKILL.commit,
          files: { 'SKILL.md': 'b'.repeat(64) },
          importedAt: SAMPLE_IMPORTED_AT,
          name: KEPT_SKILL.name,
          path: KEPT_SKILL.path,
          repo: SAMPLE_NORMALIZED_REPO,
          updatedAt: SAMPLE_IMPORTED_AT,
        };
        storeMockTextFile(
          mockFileSystem,
          DEFAULT_SKILLS_LOCKFILE_PATH,
          JSON.stringify({
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
        );

        const environment = createTestEnv();
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
            mockFileSystem.files.has(
              path.join(keptSkillDir, relativeFilePath),
            ),
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

      // priority: med
      it.todo(
        'prints the removed skill summary ("Removed <summary>") to stdout',
      );

      // priority: med
      it.todo('leaves other managed skill entries in the lockfile untouched');

      // priority: low
      it.todo('keeps stderr empty on a successful remove');
    });

    describe('partial on-disk state', () => {
      // priority: med
      it.todo(
        'removes the lockfile entry even when the on-disk skill directory is already missing',
      );
    });

    describe('config and output roots', () => {
      // priority: med
      it.todo('removes from the --config-root skills directory when provided');
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills remove" without a <name> positional argument with a commander.missingArgument error',
    );

    // priority: low
    it.todo(
      'rejects "dry-ai skills remove" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: med
    it.todo('throws when the skill name is not present in the lockfile');

    // priority: low
    it.todo(
      'throws "Managed skill not found" when the lockfile is empty (never-imported case)',
    );

    // priority: low
    it.todo(
      'throws "Managed skill not found" when the lockfile file does not exist on disk',
    );

    // priority: low
    it.todo(
      'propagates filesystem errors thrown while removing the skill directory',
    );

    // priority: low
    it.todo(
      'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
    );
  });
});
