import fsExtra from 'fs-extra';
import { glob } from 'glob';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCLI } from '../../src/cli.js';
import {
  DEFAULT_CONFIG_ROOT,
  type MockFileSystemState,
  VIRTUAL_HOME_DIR,
  configureMockFileSystem,
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
  storeMockTextFile,
} from '../helpers.js';

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

const mockedFs = vi.mocked(fsExtra);
const mockedOs = vi.mocked(os);
const mockedGlob = vi.mocked(glob);

describe('dryai sync', () => {
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
          if (path.dirname(filePath) === dir && filePath.endsWith('.md')) {
            matches.push(filePath);
          }
        }
      }

      return matches.sort();
    }) as unknown as typeof glob);
  });

  describe('happy paths', () => {
    describe('basic sync', () => {
      it('writes commands, rules, and skills into every supported agent target', async () => {
        // Arrange: seed one command, one rule, and one skill under the
        // default config root. Use distinct names for command and skill so
        // they don't collide on `.cursor/skills/<name>/SKILL.md` (the
        // Cursor command output path is skill-shaped).
        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_CONFIG_ROOT, 'commands', 'my-cmd.md'),
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

        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_CONFIG_ROOT, 'rules', 'my-rule.md'),
          [
            '---',
            'description: Test rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '---',
            '',
            'Rule body',
            '',
          ].join('\n'),
        );

        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_CONFIG_ROOT, 'skills', 'my-skill', 'SKILL.md'),
          '# My Skill\n',
        );

        const { cliOptions, stderrMessages } = createTestEnv();

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: stderr stays empty on a clean sync (no validation
        // warnings, no frontmatter errors).
        expect(stderrMessages).toEqual([]);

        // Assert: every rendered output file landed at its expected
        // per-agent target path — covering all 3 item kinds × both
        // supported agents (Copilot + Cursor).
        const expectedOutputFiles = [
          // Command → Copilot (markdown prompt file).
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'my-cmd.prompt.md',
          ),
          // Command → Cursor (skill-style SKILL.md).
          path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'my-cmd',
            'SKILL.md',
          ),
          // Rule → Copilot (`.instructions.md` file).
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'instructions',
            'my-rule.instructions.md',
          ),
          // Rule → Cursor (`.mdc` file).
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules', 'my-rule.mdc'),
          // Skill → Copilot (directory copy of the source SKILL.md).
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'skills',
            'my-skill',
            'SKILL.md',
          ),
          // Skill → Cursor (directory copy of the source SKILL.md).
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

      // priority: med
      it.todo(
        'prints the resolved output root when --output-root was provided, and stays silent otherwise',
      );

      // priority: med
      it.todo('prints the resolved output root when --test was provided');

      // priority: high
      it.todo(
        'renders a per-agent "Applied changes:" report that groups commands, rules, and skills under each agent label',
      );
    });

    describe('partial configs', () => {
      // priority: med
      it.todo(
        'syncs when only commands exist in the config root, writing nothing for missing rules/skills',
      );

      // priority: med
      it.todo(
        'syncs when only rules exist in the config root, writing nothing for missing commands/skills',
      );

      // priority: med
      it.todo(
        'syncs when only skills exist in the config root, writing nothing for missing commands/rules',
      );

      // priority: med
      it.todo(
        'is a no-op when the config root is empty, producing no output files',
      );

      // priority: high
      it.todo(
        'ensures every target root directory exists before writing (first-run bootstrap)',
      );
    });

    describe('source discovery', () => {
      // priority: high
      it.todo(
        'writes one output per markdown source file when multiple commands exist in the config root',
      );

      // priority: high
      it.todo(
        'writes one output per markdown source file when multiple rules exist in the config root',
      );

      // priority: med
      it.todo('ignores non-.md files in the commands and rules source roots');

      // priority: med
      it.todo(
        'ignores non-directory entries in the skills source root (e.g. stray files)',
      );

      // priority: med
      it.todo(
        'discovers source files only directly under the source root, not in nested subdirectories',
      );
    });

    describe('sync manifest: first-run and happy-path', () => {
      // priority: high
      it.todo(
        'creates the sync manifest on the first run when no manifest file exists yet',
      );

      // priority: high
      it.todo(
        'writes an up-to-date sync manifest (version 2) after every successful sync',
      );

      // priority: low
      it.todo(
        'orders manifest entries deterministically by agent, kind, name, outputPath',
      );
    });

    describe('sync manifest: pruning', () => {
      // priority: high
      it.todo(
        'removes files in target roots that were previously tracked in the manifest but are no longer present in the config root',
      );

      // priority: high
      it.todo(
        'leaves target-root files that were never tracked by the sync manifest untouched',
      );

      // priority: med
      it.todo(
        'reports pruned items with change-type "removed" in the per-agent sync report',
      );
    });

    describe('change-type detection', () => {
      // priority: high
      it.todo(
        'reports a new target file as "installed" when it does not already exist at the output path',
      );

      // priority: high
      it.todo(
        'reports an existing target file as "updated" when the output path already exists',
      );

      // priority: med
      it.todo(
        'reports only pruned entries as "removed"; applied entries never carry the "removed" change type',
      );
    });

    describe('ownership conflicts', () => {
      // priority: med
      it.todo(
        'skips two command files that would write to the same output path and reports both under "Skipped conflicts:"',
      );

      // priority: med
      it.todo(
        'skips two skill directories with the same directory name claiming the same target output path',
      );

      // priority: med
      it.todo(
        'still syncs non-conflicting items when some items are skipped due to conflicts',
      );

      // priority: low
      it.todo(
        'renders "Skipped conflicts: None" in green when no conflicts are detected',
      );

      // priority: low
      it.todo(
        'renders skipped conflict lines alphabetized by source item label',
      );

      // priority: low
      it.todo(
        'preserves manifest entries for items that were skipped due to a conflict, even if they are not desired this run',
      );

      // priority: low
      it.todo(
        'does not prune a previously-synced output path when the item that owns it is skipped this run due to a conflict',
      );
    });

    describe('frontmatter validation', () => {
      // priority: med
      it.todo(
        'skips a command whose top-level frontmatter fails validation and logs the skipped file to stdout',
      );

      // priority: med
      it.todo(
        'skips a rule whose top-level frontmatter fails validation and logs the skipped file to stdout',
      );

      // priority: med
      it.todo(
        'continues syncing remaining files after an invalid frontmatter file is skipped',
      );

      // priority: med
      it.todo(
        'skips a command whose agents.<agent> section fails per-agent validation and logs the agent-qualified issues',
      );

      // priority: med
      it.todo(
        'skips a rule whose agents.<agent> section fails per-agent validation and logs the agent-qualified issues',
      );

      // priority: low
      it.todo(
        'skips a command whose agents block references an unknown agent name and lists it as "Unsupported agent"',
      );

      // priority: low
      it.todo(
        'skips a rule whose agents block references an unknown agent name and lists it as "Unsupported agent"',
      );
    });

    describe('per-agent output paths', () => {
      // priority: high
      it.todo(
        'writes Copilot command, rule, and skill files into the Copilot target layout',
      );

      // priority: high
      it.todo(
        'writes Cursor command, rule, and skill files into the Cursor target layout',
      );

      // priority: med
      it.todo(
        'honors per-agent frontmatter overrides when the agents section provides valid data',
      );
    });

    describe('rendered markdown output', () => {
      // priority: high
      it.todo(
        'writes command output as "---\\n<yaml>\\n---\\n<body>\\n" with the body trimmed of surrounding blank lines',
      );

      // priority: high
      it.todo(
        'writes rule output as "---\\n<yaml>\\n---\\n<body>\\n" with the body trimmed of surrounding blank lines',
      );

      // priority: med
      it.todo(
        'omits metadata fields whose resolved value is undefined (compactObject) from the rendered YAML frontmatter',
      );
    });

    describe('cursor rule globs/applyTo cascade', () => {
      // priority: med
      it.todo(
        'defaults the Cursor rule globs to the Copilot applyTo string when the cursor section does not provide its own globs',
      );

      // priority: med
      it.todo(
        'sets alwaysApply=true and drops globs from the rendered frontmatter when the resolved globs value is "**"',
      );

      // priority: med
      it.todo(
        'sets alwaysApply=true and drops globs from the rendered frontmatter when neither the cursor section nor the copilot applyTo provides a globs value',
      );

      // priority: low
      it.todo(
        'keeps the explicit alwaysApply value from the cursor section when it is provided, regardless of globs',
      );
    });

    describe('skill directory copy semantics', () => {
      // priority: high
      it.todo(
        'copies every file and subdirectory from the skill source into each agent target directory',
      );

      // priority: high
      it.todo(
        'empties the target skill directory before copying so removed source files are not left behind',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dryai sync" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: med
    it.todo('throws when the config root does not exist on disk');

    // priority: low
    it.todo('propagates filesystem errors thrown while writing a target file');

    // priority: low
    it.todo(
      'throws when the existing manifest file fails schema validation (version mismatch or malformed entries)',
    );
  });
});
