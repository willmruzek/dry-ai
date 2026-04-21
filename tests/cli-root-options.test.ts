import fsExtra from 'fs-extra';
import { glob } from 'glob';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCLI } from '../src/cli.js';
import {
  DEFAULT_CONFIG_ROOT,
  DEFAULT_SKILLS_LOCKFILE_PATH,
  type MockFileSystemState,
  VIRTUAL_HOME_DIR,
  configureMockFileSystem,
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
  storeMockTextFile,
} from './helpers.js';

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

// `lib/sync.ts` uses `glob` to discover command/rule markdown files; mock it
// so sync discovers files seeded into our virtual filesystem instead of
// reading the real disk.
vi.mock('glob', () => ({
  glob: vi.fn(),
}));

// `vi.mocked` is a pure type helper: it returns the same runtime value (the
// mocked default export) but types each method as the corresponding
// `MockedFunction<typeof fs.method>`, so `.mockResolvedValue` / `.mockReturnValue`
// calls are checked against the real module signatures.
const mockedFs = vi.mocked(fsExtra);
const mockedOs = vi.mocked(os);
const mockedGlob = vi.mocked(glob);

// Root-option coverage is exercised against `dry-ai skills list`, the simplest
// read-only command. Its stdout deterministically reflects which config root
// the CLI resolved (via the contents of the lockfile it loaded), without
// requiring git or sync machinery.

describe('dry-ai root options', () => {
  let mockFileSystem: MockFileSystemState;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();
    configureMockFileSystem(mockFileSystem, mockedFs);
    configureMockOs(mockedOs, {
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });

    // Resolve `<rootDir>/*.md` patterns (the only shape `lib/sync.ts` uses)
    // against the virtual filesystem, returning matches in sorted order.
    mockedGlob.mockImplementation((async (
      patterns: string | string[],
    ): Promise<string[]> => {
      const patternList = Array.isArray(patterns) ? patterns : [patterns];
      const matches: string[] = [];

      for (const pattern of patternList) {
        const patternMatch = /^(?<dir>.+)\/\*\.md$/.exec(pattern);
        if (!patternMatch?.groups) {
          continue;
        }

        const { dir } = patternMatch.groups;

        for (const filePath of mockFileSystem.files.keys()) {
          if (
            path.dirname(filePath) === dir &&
            filePath.endsWith('.md')
          ) {
            matches.push(filePath);
          }
        }
      }

      return matches.sort();
    }) as unknown as typeof glob);
  });

  describe('happy paths', () => {
    describe('default paths', () => {
      it('reads configs from the default config root when neither --config-root nor --test is passed', async () => {
        // Arrange: seed the default (home-derived) config root with a
        // managed skill.
        const seededLockfile = {
          version: 1,
          skills: [
            {
              commit: 'abcdef1234567890',
              files: {},
              importedAt: '2026-04-14T00:00:00.000Z',
              name: 'review-helper',
              path: 'skills/review-helper',
              repo: 'https://github.com/anthropics/skills.git',
              updatedAt: '2026-04-14T00:00:00.000Z',
            },
          ],
        };

        storeMockTextFile(
          mockFileSystem,
          DEFAULT_SKILLS_LOCKFILE_PATH,
          JSON.stringify(seededLockfile),
        );

        const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

        // Act
        await runCLI({
          argv: ['skills', 'list'],
          ...cliOptions,
        });

        // Assert: stdout reflects the seeded skill, proving the CLI read
        // the lockfile from the home-derived default config root.
        const stdout = stdoutMessages.join('');

        expect(stderrMessages).toEqual([]);
        expect(stdout).toContain('review-helper');
        expect(stdout).toContain(
          'repo=https://github.com/anthropics/skills.git',
        );
        expect(stdout).toContain('path=skills/review-helper');
      });

      it('writes generated output under the user home directory when neither --output-root nor --test is passed', async () => {
        // Arrange: seed one command source and one skill source under the
        // default config root. Sync should render outputs for each into
        // every supported agent's target layout under the home directory.
        const commandSourcePath = path.join(
          DEFAULT_CONFIG_ROOT,
          'commands',
          'my-cmd.md',
        );
        storeMockTextFile(
          mockFileSystem,
          commandSourcePath,
          [
            '---',
            'name: my-cmd',
            'description: Test command',
            '---',
            '',
            'Command body',
            '',
          ].join('\n'),
        );

        const skillSourceFilePath = path.join(
          DEFAULT_CONFIG_ROOT,
          'skills',
          'my-skill',
          'SKILL.md',
        );
        storeMockTextFile(mockFileSystem, skillSourceFilePath, '# My Skill\n');

        const { cliOptions, stderrMessages } = createTestEnv();

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: every rendered output file is on disk under the home
        // directory, proving the default output root === homeDir.
        expect(stderrMessages).toEqual([]);

        const expectedOutputFiles = [
          // Command → Copilot (markdown prompt file)
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'my-cmd.prompt.md',
          ),
          // Command → Cursor (skill-style SKILL.md)
          path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'my-cmd',
            'SKILL.md',
          ),
          // Skill → Copilot (directory copy of the source SKILL.md)
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'skills',
            'my-skill',
            'SKILL.md',
          ),
          // Skill → Cursor (directory copy of the source SKILL.md)
          path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'my-skill',
            'SKILL.md',
          ),
        ];

        for (const outputPath of expectedOutputFiles) {
          expect(mockFileSystem.files.has(outputPath)).toBe(true);
        }
      });
    });

    describe('--config-root', () => {
      // priority: med
      it.todo('reads configs from an absolute path passed via --config-root');

      // priority: med
      it.todo(
        'expands a leading ~ in --config-root to the user home directory',
      );

      // priority: med
      it.todo('expands ~/subpath in --config-root to <home>/subpath');
    });

    describe('--output-root', () => {
      // priority: med
      it.todo(
        'writes generated output under an absolute path passed via --output-root',
      );

      // priority: med
      it.todo(
        'expands a leading ~ in --output-root to the user home directory',
      );

      // priority: med
      it.todo('expands ~/subpath in --output-root to <home>/subpath');
    });

    describe('--test', () => {
      // priority: med
      it.todo(
        'writes generated output under ./output-test when --test is passed without --output-root',
      );

      // priority: low
      it.todo(
        'prefers the --output-root value over ./output-test when both --test and --output-root are passed',
      );

      // priority: med
      it.todo(
        'does not change the config root resolution; --test only affects the output root',
      );
    });

    describe('post-run output root notice', () => {
      // priority: med
      it.todo(
        'prints "Generated output written to <path>" after sync when --output-root was provided',
      );

      // priority: med
      it.todo(
        'prints "Generated output written to <path>" after sync when --test was provided',
      );

      // priority: med
      it.todo(
        'does not print the output-root notice when neither --output-root nor --test was provided',
      );
    });

    describe('flag placement', () => {
      // priority: med
      it.todo(
        'accepts --config-root before the subcommand (e.g. "dry-ai --config-root /tmp sync")',
      );

      // priority: med
      it.todo(
        'accepts --output-root before the subcommand (e.g. "dry-ai --output-root /tmp sync")',
      );

      // priority: med
      it.todo('accepts --test before the subcommand');

      // priority: low
      it.todo(
        'accepts --config-root after the subcommand (e.g. "dry-ai sync --config-root /tmp")',
      );

      // priority: low
      it.todo(
        'accepts --output-root after the subcommand (e.g. "dry-ai sync --output-root /tmp")',
      );

      // priority: low
      it.todo(
        'accepts --test after the subcommand (e.g. "dry-ai sync --test")',
      );
    });
  });

  describe('sad paths', () => {
    describe('--config-root', () => {
      // priority: low
      it.todo(
        'rejects an empty --config-root value with a validation error from the non-empty string schema',
      );

      // priority: low
      it.todo('rejects a missing value for --config-root as a commander error');
    });

    describe('--output-root', () => {
      // priority: low
      it.todo(
        'rejects an empty --output-root value with a validation error from the non-empty string schema',
      );

      // priority: low
      it.todo('rejects a missing value for --output-root as a commander error');
    });
  });
});
