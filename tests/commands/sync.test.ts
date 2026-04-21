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
  readMockTextFile,
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

describe('dry-ai sync', () => {
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
      type StaleManifestEntry = {
        agent: 'copilot' | 'cursor';
        kind: 'command' | 'rule' | 'skill';
        name: string;
        outputPath: string;
      };

      /**
       * Seeds one current command source (`current.md`) so each prune
       * test has at least one applied item alongside the pruned one.
       * This mirrors a realistic incremental sync (where some items
       * stayed and some were deleted from the config root) and gives
       * the per-agent report both `installed`/`updated` lines AND
       * `removed` lines to render side by side.
       */
      function seedCurrentCommandSource(): void {
        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_CONFIG_ROOT, 'commands', 'current.md'),
          [
            '---',
            'name: current',
            'description: Still-present command',
            '---',
            '',
            'Current body',
            '',
          ].join('\n'),
        );
      }

      /**
       * Writes the prior `sync-manifest.json` (version 2) to the config
       * root with the given stale entries — i.e. entries whose
       * `outputPath` is no longer claimed by any current source, so
       * `collectRemovedManifestEntries` will mark them as orphaned and
       * `removeStaleOutputs` will `fs.remove` them.
       */
      function seedPriorManifest(staleEntries: StaleManifestEntry[]): void {
        storeMockTextFile(
          mockFileSystem,
          path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
          JSON.stringify({ version: 2, outputs: staleEntries }),
        );
      }

      /**
       * Arranges a stale `command` named `gone-cmd` — seeds its on-disk
       * outputs (Copilot prompt file + Cursor skill-style SKILL.md) and
       * the prior manifest entries that point to them.
       */
      function arrangeStaleCommand(): {
        copilotOutputPath: string;
        cursorOutputPath: string;
      } {
        const copilotOutputPath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'prompts',
          'gone-cmd.prompt.md',
        );
        const cursorOutputPath = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'skills',
          'gone-cmd',
          'SKILL.md',
        );

        storeMockTextFile(mockFileSystem, copilotOutputPath, '# stale prompt\n');
        storeMockTextFile(mockFileSystem, cursorOutputPath, '# stale skill\n');

        seedPriorManifest([
          {
            agent: 'copilot',
            kind: 'command',
            name: 'gone-cmd',
            outputPath: copilotOutputPath,
          },
          {
            agent: 'cursor',
            kind: 'command',
            name: 'gone-cmd',
            outputPath: cursorOutputPath,
          },
        ]);

        return { copilotOutputPath, cursorOutputPath };
      }

      /**
       * Arranges a stale `rule` named `gone-rule` — seeds its on-disk
       * outputs (Copilot `.instructions.md` + Cursor `.mdc`) and the
       * prior manifest entries that point to them.
       */
      function arrangeStaleRule(): {
        copilotOutputPath: string;
        cursorOutputPath: string;
      } {
        const copilotOutputPath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'instructions',
          'gone-rule.instructions.md',
        );
        const cursorOutputPath = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'rules',
          'gone-rule.mdc',
        );

        storeMockTextFile(
          mockFileSystem,
          copilotOutputPath,
          '# stale instructions\n',
        );
        storeMockTextFile(mockFileSystem, cursorOutputPath, '# stale mdc\n');

        seedPriorManifest([
          {
            agent: 'copilot',
            kind: 'rule',
            name: 'gone-rule',
            outputPath: copilotOutputPath,
          },
          {
            agent: 'cursor',
            kind: 'rule',
            name: 'gone-rule',
            outputPath: cursorOutputPath,
          },
        ]);

        return { copilotOutputPath, cursorOutputPath };
      }

      /**
       * Arranges a stale `skill` named `gone-skill` — seeds multiple
       * files inside each agent's skill directory (so the test can
       * assert that pruning a skill's `outputPath`, which is the
       * directory itself, removes the entire subtree, not just one
       * file) and the prior manifest entries that point to those
       * directories.
       */
      function arrangeStaleSkill(): {
        copilotInnerFiles: string[];
        cursorInnerFiles: string[];
      } {
        const copilotSkillDir = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'skills',
          'gone-skill',
        );
        const cursorSkillDir = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'skills',
          'gone-skill',
        );
        const copilotInnerFiles = [
          path.join(copilotSkillDir, 'SKILL.md'),
          path.join(copilotSkillDir, 'rules.md'),
        ];
        const cursorInnerFiles = [
          path.join(cursorSkillDir, 'SKILL.md'),
          path.join(cursorSkillDir, 'rules.md'),
        ];

        for (const filePath of [...copilotInnerFiles, ...cursorInnerFiles]) {
          storeMockTextFile(
            mockFileSystem,
            filePath,
            `# stale ${path.basename(filePath)}\n`,
          );
        }

        seedPriorManifest([
          {
            agent: 'copilot',
            kind: 'skill',
            name: 'gone-skill',
            outputPath: copilotSkillDir,
          },
          {
            agent: 'cursor',
            kind: 'skill',
            name: 'gone-skill',
            outputPath: cursorSkillDir,
          },
        ]);

        return { copilotInnerFiles, cursorInnerFiles };
      }

      it("removes a previously-tracked command's per-agent outputs when its source has been deleted from the config root", async () => {
        // Arrange: prior manifest tracks `gone-cmd` outputs whose
        // command source is no longer present; one current command
        // (`current`) keeps the run from being a pure-prune scenario.
        seedCurrentCommandSource();
        const { copilotOutputPath, cursorOutputPath } = arrangeStaleCommand();
        const { cliOptions, stderrMessages } = createTestEnv();

        // Sanity check: the stale outputs were actually seeded on disk
        // before the run, so a `false` post-run assertion isn't trivially
        // true (e.g. due to a bad path in `arrangeStaleCommand`).
        expect(mockFileSystem.files.has(copilotOutputPath)).toBe(true);
        expect(mockFileSystem.files.has(cursorOutputPath)).toBe(true);

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: both stale per-agent command outputs were pruned.
        expect(mockFileSystem.files.has(copilotOutputPath)).toBe(false);
        expect(mockFileSystem.files.has(cursorOutputPath)).toBe(false);

        // Assert: the still-present command's outputs were written, so
        // pruning didn't accidentally short-circuit the apply phase.
        expect(
          mockFileSystem.files.has(
            path.join(
              VIRTUAL_HOME_DIR,
              '.copilot',
              'prompts',
              'current.prompt.md',
            ),
          ),
        ).toBe(true);

        // Assert: clean run.
        expect(stderrMessages).toEqual([]);
      });

      it("removes a previously-tracked rule's per-agent outputs when its source has been deleted from the config root", async () => {
        // Arrange: prior manifest tracks `gone-rule` outputs (Copilot
        // `.instructions.md` + Cursor `.mdc`) whose rule source is no
        // longer present; one current command keeps the apply phase
        // exercised.
        seedCurrentCommandSource();
        const { copilotOutputPath, cursorOutputPath } = arrangeStaleRule();
        const { cliOptions, stderrMessages } = createTestEnv();

        // Sanity check: stale outputs were seeded on disk pre-run so
        // the post-run `false` assertion can't pass for the wrong
        // reason.
        expect(mockFileSystem.files.has(copilotOutputPath)).toBe(true);
        expect(mockFileSystem.files.has(cursorOutputPath)).toBe(true);

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: both stale per-agent rule outputs were pruned —
        // covering the `.instructions.md` (Copilot) and `.mdc` (Cursor)
        // path shapes that differ from the command path layout.
        expect(mockFileSystem.files.has(copilotOutputPath)).toBe(false);
        expect(mockFileSystem.files.has(cursorOutputPath)).toBe(false);

        // Assert: clean run.
        expect(stderrMessages).toEqual([]);
      });

      it("removes a previously-tracked skill's per-agent directories (and every file inside them) when its source has been deleted from the config root", async () => {
        // Arrange: prior manifest tracks `gone-skill` directory
        // outputs; multiple files seeded inside each agent's skill
        // directory let us assert the full subtree is pruned, not just
        // a top-level file at the manifest's `outputPath`.
        seedCurrentCommandSource();
        const { copilotInnerFiles, cursorInnerFiles } = arrangeStaleSkill();
        const { cliOptions, stderrMessages } = createTestEnv();

        // Sanity check: every inner file was seeded on disk pre-run, so
        // the post-run `false` assertions can't all pass for the wrong
        // reason (e.g. wrong dir paths in `arrangeStaleSkill`).
        for (const filePath of [...copilotInnerFiles, ...cursorInnerFiles]) {
          expect(mockFileSystem.files.has(filePath)).toBe(true);
        }

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: every file that lived inside either agent's stale
        // skill directory is gone — proves `fs.remove(<skillDir>)`
        // cleaned up the subtree (skills are directory-shaped outputs,
        // unlike commands and rules which are single-file outputs).
        for (const filePath of [...copilotInnerFiles, ...cursorInnerFiles]) {
          expect(mockFileSystem.files.has(filePath)).toBe(false);
        }

        // Assert: clean run.
        expect(stderrMessages).toEqual([]);
      });

      it('leaves target-root files that were never tracked by the sync manifest untouched', async () => {
        // Arrange: no prior manifest, no current sources, just a single
        // hand-authored file under one of the target roots — i.e. the
        // realistic case of a user with their own files alongside a
        // first-ever `dry-ai sync`.
        const untrackedFilePath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'prompts',
          'handcrafted.prompt.md',
        );
        const untrackedFileContent = '# handcrafted\n';
        storeMockTextFile(
          mockFileSystem,
          untrackedFilePath,
          untrackedFileContent,
        );

        const { cliOptions, stderrMessages } = createTestEnv();

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: the untracked file is still on disk with its original
        // bytes — sync must not touch outputs it didn't manage.
        expect(mockFileSystem.files.has(untrackedFilePath)).toBe(true);
        expect(readMockTextFile(mockFileSystem, untrackedFilePath)).toBe(
          untrackedFileContent,
        );

        // Assert: clean run, no warnings.
        expect(stderrMessages).toEqual([]);
      });

      it('reports pruned items with change-type "removed" in the per-agent sync report', async () => {
        // Arrange: reuse the command-prune setup so the report has both
        // applied (`current`) and removed (`gone-cmd`) entries to
        // render under each agent. The kind under test here is the
        // report rendering, not the prune path itself — `command` is
        // sufficient since the report code is uniform across kinds.
        seedCurrentCommandSource();
        arrangeStaleCommand();
        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv();

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // The full report is emitted as a single `logInfo` line. Chalk
        // (level 3) only wraps individual tokens, not whole lines, so
        // raw substring + per-line regex assertions still work without
        // stripping ANSI.
        const stdout = stdoutMessages.join('');

        // Assert: the pruned entry name and the "removed" label both
        // appear, on the SAME line (rendered as
        // `    - <name> (<changeType>)`), so we can be sure `gone-cmd`
        // was reported as removed and not e.g. installed.
        expect(stdout).toMatch(/gone-cmd[^\n]*removed/);

        // Assert: both agent labels appear in the report — the pruned
        // entry was tracked in both Copilot and Cursor manifest entries,
        // so each agent section should render its own "removed" line.
        expect(stdout).toContain('Copilot');
        expect(stdout).toContain('Cursor');

        // Assert: clean run.
        expect(stderrMessages).toEqual([]);
      });
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
      'rejects "dry-ai sync" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
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
