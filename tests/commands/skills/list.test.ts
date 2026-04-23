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

describe('dry-ai skills list', () => {
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
    describe('basic list', () => {
      it('lists every local skill directory with its managed summary when all skills are in the lockfile', async () => {
        // Arrange: seed two local skill directories AND matching lockfile
        // entries, so every on-disk skill is "managed". Seeding the skills in
        // reverse-alphabetical mock-insertion order verifies the output is
        // driven by `listLocalSkillDirectories`'s sort, not by insertion
        // order.
        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_SKILLS_SOURCE_ROOT, SECOND_SKILL.name, 'SKILL.md'),
          '---\nname: review-helper\n---\n\n# Review helper\n',
        );
        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_SKILLS_SOURCE_ROOT, FIRST_SKILL.name, 'SKILL.md'),
          '---\nname: note-taker\n---\n\n# Note taker\n',
        );
        storeMockTextFile(
          mockFileSystem,
          DEFAULT_SKILLS_LOCKFILE_PATH,
          JSON.stringify({
            version: 1,
            skills: [
              {
                commit: FIRST_SKILL.commit,
                files: { 'SKILL.md': 'a'.repeat(64) },
                importedAt: SAMPLE_IMPORTED_AT,
                name: FIRST_SKILL.name,
                path: FIRST_SKILL.path,
                repo: SAMPLE_NORMALIZED_REPO,
                updatedAt: SAMPLE_IMPORTED_AT,
              },
              {
                commit: SECOND_SKILL.commit,
                files: { 'SKILL.md': 'b'.repeat(64) },
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
          argv: ['skills', 'list'],
          ...environment.cliOptions,
        });

        // Assert: stdout is one logInfo payload with one "- <summary>" line
        // per local skill. No "unmanaged" suffix (both are tracked) and no
        // "missing-local-directory" suffix (both have on-disk directories).
        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          [
            `- ${FIRST_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${FIRST_SKILL.path} ref=HEAD commit=${FIRST_SKILL.commit.slice(0, 7)}`,
            `- ${SECOND_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${SECOND_SKILL.path} ref=HEAD commit=${SECOND_SKILL.commit.slice(0, 7)}`,
            '',
          ].join('\n'),
        ]);
      });

      // priority: med
      it.todo(
        'prints "No local skills found." when neither local directories nor lockfile entries exist',
      );

      it('creates the skills root directory on first run if it is missing', async () => {
        // Arrange: fresh mock filesystem with neither a skills root directory
        // nor a lockfile. Sanity-check the pre-state so the post-state
        // assertion below is meaningful.
        expect(mockFileSystem.directories.has(DEFAULT_SKILLS_SOURCE_ROOT)).toBe(
          false,
        );

        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'list'],
          ...environment.cliOptions,
        });

        // Assert: `skills list` called `fs.ensureDir(skillsRoot)` and the
        // directory is now present in the mock filesystem.
        expect(mockedFs.ensureDir).toHaveBeenCalledWith(
          DEFAULT_SKILLS_SOURCE_ROOT,
        );
        expect(mockFileSystem.directories.has(DEFAULT_SKILLS_SOURCE_ROOT)).toBe(
          true,
        );

        // Assert: with no local skills and no lockfile, stdout is the
        // empty-state message and stderr is empty.
        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          'No local skills found.\n',
        ]);
      });

      // priority: low
      it.todo('keeps stderr empty on every successful list invocation');
    });

    describe('managed vs unmanaged annotation', () => {
      // priority: med
      it.todo(
        'labels a local skill directory as "unmanaged" when it is not tracked by the lockfile',
      );

      // priority: med
      it.todo(
        'labels a lockfile entry as "missing-local-directory" when its on-disk directory is absent',
      );

      // priority: med
      it.todo(
        'prints managed skills before missing-local-directory entries in the output',
      );

      // priority: med
      it.todo(
        'renders a mixed output (managed + unmanaged + missing-local-directory) in a single invocation',
      );
    });

    describe('ordering', () => {
      // priority: low
      it.todo(
        'orders local skill entries alphabetically (case-sensitive localeCompare) regardless of the filesystem listing order',
      );

      // priority: low
      it.todo(
        'orders multiple missing-local-directory entries by their position in the (already name-sorted) lockfile skills array',
      );
    });

    describe('lockfile edge cases', () => {
      // priority: med
      it.todo(
        'treats a missing lockfile file identically to an empty lockfile (no managed annotations)',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills list" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    describe('lockfile edge cases', () => {
      // priority: low
      it.todo(
        'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
      );
    });
  });
});
