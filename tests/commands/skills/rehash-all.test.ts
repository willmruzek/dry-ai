import os from 'node:os';
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
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
  hashFileSet,
  readMockTextFile,
  seedLocalSkillDirectory,
  storeMockTextFile,
} from '../../helpers.js';

const REHASHED_AT = '2026-05-01T12:00:00.000Z';

const FIRST_SKILL = {
  name: 'note-taker',
  path: 'skills/note-taker',
  commit: 'abcdef1234567890',
  files: {
    'SKILL.md': '---\nname: note-taker\n---\n\n# Note taker (updated)\n',
    'rules.md': '# new rules\n',
  },
} as const;

const SECOND_SKILL = {
  name: 'review-helper',
  path: 'skills/review-helper',
  commit: '1234567890abcdef',
  files: {
    'SKILL.md': '---\nname: review-helper\n---\n\n# Review helper (updated)\n',
    'guides/checklist.md': '- new item\n',
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

describe('dry-ai skills rehash-all', () => {
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

    vi.useFakeTimers();
    vi.setSystemTime(new Date(REHASHED_AT));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('happy paths', () => {
    describe('basic rehash-all', () => {
      it('rehashes every managed skill in the lockfile and saves the updated lockfile once', async () => {
        // Arrange: seed two managed skills with deliberately-stale hashes in
        // the lockfile. Their on-disk content uses different bytes, so a real
        // rehash pass must rewrite the `files` hashes.
        const stalePlaceholderHash = 'a'.repeat(64);
        const seededLockfile = {
          version: 1,
          skills: [
            {
              commit: FIRST_SKILL.commit,
              files: { 'SKILL.md': stalePlaceholderHash },
              importedAt: SAMPLE_IMPORTED_AT,
              name: FIRST_SKILL.name,
              path: FIRST_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: SAMPLE_IMPORTED_AT,
            },
            {
              commit: SECOND_SKILL.commit,
              files: { 'SKILL.md': stalePlaceholderHash },
              importedAt: SAMPLE_IMPORTED_AT,
              name: SECOND_SKILL.name,
              path: SECOND_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: SAMPLE_IMPORTED_AT,
            },
          ],
        };
        storeMockTextFile(
          mockFileSystem,
          DEFAULT_SKILLS_LOCKFILE_PATH,
          JSON.stringify(seededLockfile),
        );
        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          FIRST_SKILL.name,
          FIRST_SKILL.files,
        );
        seedLocalSkillDirectory(
          mockFileSystem,
          DEFAULT_SKILLS_SOURCE_ROOT,
          SECOND_SKILL.name,
          SECOND_SKILL.files,
        );

        const environment = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'rehash-all'],
          ...environment.cliOptions,
        });

        // Assert: one stdout line summarizing all rehashed skills, stderr empty.
        expect(environment.stderrMessages).toEqual([]);
        expect(environment.stdoutMessages).toEqual([
          [
            'Rehashed 2 managed skills:',
            `- ${FIRST_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${FIRST_SKILL.path} ref=HEAD commit=${FIRST_SKILL.commit.slice(0, 7)}`,
            `- ${SECOND_SKILL.name} repo=${SAMPLE_NORMALIZED_REPO} path=${SECOND_SKILL.path} ref=HEAD commit=${SECOND_SKILL.commit.slice(0, 7)}`,
            '',
          ].join('\n'),
        ]);

        // Assert: the lockfile was saved exactly once (rehash-all accumulates
        // per-skill updates in memory and persists them in a single write).
        expect(mockFileSystem.lockfileWrites).toHaveLength(1);

        // Assert: every entry has fresh hashes + updatedAt; commit/repo/path/
        // importedAt are unchanged.
        const savedLockfile = JSON.parse(
          readMockTextFile(mockFileSystem, DEFAULT_SKILLS_LOCKFILE_PATH),
        ) as unknown;
        expect(savedLockfile).toEqual({
          version: 1,
          skills: [
            {
              commit: FIRST_SKILL.commit,
              files: hashFileSet(FIRST_SKILL.files),
              importedAt: SAMPLE_IMPORTED_AT,
              name: FIRST_SKILL.name,
              path: FIRST_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: REHASHED_AT,
            },
            {
              commit: SECOND_SKILL.commit,
              files: hashFileSet(SECOND_SKILL.files),
              importedAt: SAMPLE_IMPORTED_AT,
              name: SECOND_SKILL.name,
              path: SECOND_SKILL.path,
              repo: SAMPLE_NORMALIZED_REPO,
              updatedAt: REHASHED_AT,
            },
          ],
        });
      });

      // priority: med
      it.todo(
        'prints a multi-line summary that includes the count and each rehashed skill',
      );

      // priority: med
      it.todo(
        'prints "No managed skills to rehash." and exits cleanly when the lockfile is empty',
      );

      // priority: low
      it.todo('rehashes a single-entry lockfile and reports a count of 1');

      // priority: low
      it.todo(
        'keeps stderr empty when every managed skill rehashes successfully',
      );
    });

    describe('missing local directories', () => {
      // priority: med
      it.todo(
        'skips managed skills whose local directory is missing and reports them on stderr as "missing-local-directory"',
      );

      // priority: med
      it.todo(
        'still rehashes and saves every managed skill whose local directory is present, even when others were skipped',
      );

      // priority: med
      it.todo(
        'prints "No managed skills were rehashed." when every managed skill is missing its local directory',
      );

      // priority: med
      it.todo(
        'reports updated skills on stdout and skipped skills on stderr in the same invocation',
      );
    });

    describe('lockfile semantics', () => {
      // priority: med
      it.todo(
        'sets updatedAt on every rehashed entry and leaves commit/ref/repo/importedAt unchanged',
      );

      // priority: med
      it.todo(
        'leaves skipped lockfile entries (missing local directories) untouched',
      );

      // priority: low
      it.todo(
        'preserves the original lockfile entry order after a mixed rehash + skip run',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills rehash-all" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: low
    it.todo(
      'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
    );
  });
});
