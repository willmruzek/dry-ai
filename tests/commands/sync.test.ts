import os from 'node:os';
import path from 'node:path';

import { glob } from 'glob';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runCLI } from '../../src/cli.js';
import type { SyncAgent } from '../../src/lib/agents.js';

import {
  DEFAULT_CONFIG_ROOT,
  type MockFileSystemHandle,
  VIRTUAL_HOME_DIR,
  configureMockFileSystem,
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
  deleteMockTextFile,
  normalizeMockPath,
  readMockTextFile,
  removeMockPath,
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

const mockedOs = vi.mocked(os);
const mockedGlob = vi.mocked(glob);

/**
 * Strips chalk's ANSI CSI escape codes (e.g. `\x1B[1m`) from a string
 * so report assertions can focus on structure rather than baking
 * chalk's styling bytes into the expected output.
 */
const stripAnsi = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

/**
 * Expected per-target `outputPath` for `arrangeBasicSources()` (my-cmd, my-rule, my-skill).
 * Test fixture for the two-agent layout.
 */
type ManifestTrioRow = {
  agent: 'copilot' | 'cursor';
  kind: 'command' | 'rule' | 'skill';
  name: string;
  outputPath: string;
};

function buildExpectedManifestTrio(outputRoot: string): ManifestTrioRow[] {
  return [
    {
      agent: 'copilot',
      kind: 'command',
      name: 'my-cmd',
      outputPath: path.join(
        outputRoot,
        '.copilot',
        'prompts',
        'my-cmd.prompt.md',
      ),
    },
    {
      agent: 'copilot',
      kind: 'rule',
      name: 'my-rule',
      outputPath: path.join(
        outputRoot,
        '.copilot',
        'instructions',
        'my-rule.instructions.md',
      ),
    },
    {
      agent: 'copilot',
      kind: 'skill',
      name: 'my-skill',
      outputPath: path.join(outputRoot, '.copilot', 'skills', 'my-skill'),
    },
    {
      agent: 'cursor',
      kind: 'command',
      name: 'my-cmd',
      outputPath: path.join(outputRoot, '.cursor', 'skills', 'my-cmd'),
    },
    {
      agent: 'cursor',
      kind: 'rule',
      name: 'my-rule',
      outputPath: path.join(outputRoot, '.cursor', 'rules', 'my-rule.mdc'),
    },
    {
      agent: 'cursor',
      kind: 'skill',
      name: 'my-skill',
      outputPath: path.join(outputRoot, '.cursor', 'skills', 'my-skill'),
    },
  ];
}

/**
 * Two manifest rows for one command, matching `AGENT_DEFINITIONS` / `buildSyncTargets`:
 * Copilot `*.prompt.md` path uses the source file stem; Cursor’s command skill
 * directory uses frontmatter `name` (the manifest `name` field matches
 * `collectManifestEntries` / `commandMetadata.name`).
 */
function buildExpectedManifestCommandRows(
  outputRoot: string,
  {
    commandName,
    sourceFileStem,
  }: { commandName: string; sourceFileStem: string },
): ManifestTrioRow[] {
  return [
    {
      agent: 'copilot',
      kind: 'command',
      name: commandName,
      outputPath: path.join(
        outputRoot,
        '.copilot',
        'prompts',
        `${sourceFileStem}.prompt.md`,
      ),
    },
    {
      agent: 'cursor',
      kind: 'command',
      name: commandName,
      outputPath: path.join(outputRoot, '.cursor', 'skills', commandName),
    },
  ];
}

/**
 * On-disk file paths for `arrangeBasicSources()` under `outputRoot` (file-level, including
 * `SKILL.md` for Cursor command targets). Test fixture.
 */
function buildExpectedTrioProductFilePaths(outputRoot: string): string[] {
  return [
    path.join(outputRoot, '.copilot', 'prompts', 'my-cmd.prompt.md'),
    path.join(outputRoot, '.cursor', 'skills', 'my-cmd', 'SKILL.md'),
    path.join(
      outputRoot,
      '.copilot',
      'instructions',
      'my-rule.instructions.md',
    ),
    path.join(outputRoot, '.cursor', 'rules', 'my-rule.mdc'),
    path.join(outputRoot, '.copilot', 'skills', 'my-skill', 'SKILL.md'),
    path.join(outputRoot, '.cursor', 'skills', 'my-skill', 'SKILL.md'),
  ];
}

/** Fixture `sync-manifest.json` shape; `version` must match the CLI’s on-disk schema. */
const MOCK_SYNC_MANIFEST_VERSION = 2 as const;

const mockSyncManifestSchema = z.object({
  version: z.literal(MOCK_SYNC_MANIFEST_VERSION),
  outputs: z.array(
    z.object({
      agent: z.enum(['copilot', 'cursor']),
      kind: z.enum(['command', 'rule', 'skill']),
      name: z.string().min(1),
      outputPath: z.string().min(1),
    }),
  ),
});

/**
 * Exhaustive `Record<SyncAgent, …>`: `satisfies` requires a key for every registry
 * agent or TypeScript fails at compile time.
 */
const e2eOutputTreeTestCoverageByAgent = {
  copilot: true,
  cursor: true,
} satisfies Record<SyncAgent, true>;

function compareManifestEntryTuples(
  left: { agent: string; kind: string; name: string; outputPath: string },
  right: { agent: string; kind: string; name: string; outputPath: string },
): number {
  return [left.agent, left.kind, left.name, left.outputPath]
    .join('\0')
    .localeCompare(
      [right.agent, right.kind, right.name, right.outputPath].join('\0'),
    );
}

function assertMockSyncManifestMatchesExpectedRows(
  state: MockFileSystemHandle,
  configRoot: string,
  expectedRows: ManifestTrioRow[],
): void {
  const manifestPath = path.join(configRoot, 'sync-manifest.json');
  const raw = readMockTextFile({ handle: state, filePath: manifestPath });
  const { outputs } = mockSyncManifestSchema.parse(JSON.parse(raw));

  const normalizedExpected = expectedRows.map((row) => ({
    ...row,
    outputPath: path.normalize(row.outputPath),
  }));
  const actualRows = outputs.map((o) => ({
    ...o,
    outputPath: path.normalize(o.outputPath),
  }));
  const sortedExpected = normalizedExpected
    .slice()
    .sort(compareManifestEntryTuples);
  const sortedActual = actualRows.slice().sort(compareManifestEntryTuples);
  expect(sortedActual).toEqual(sortedExpected);
}

function assertMockSyncManifestMatchesTrio(
  state: MockFileSystemHandle,
  configRoot: string,
  outputRoot: string,
): void {
  const expectedRows = buildExpectedManifestTrio(outputRoot);
  for (const agent of ['copilot', 'cursor'] as const) {
    expect(expectedRows.filter((row) => row.agent === agent)).toHaveLength(3);
  }
  assertMockSyncManifestMatchesExpectedRows(state, configRoot, expectedRows);
}

describe('dry-ai sync', () => {
  let mockFileSystem: MockFileSystemHandle;

  beforeEach(() => {
    mockFileSystem = createMockFileSystemState();
    configureMockFileSystem({ handle: mockFileSystem });
    configureMockOs({
      mockedOs: mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });

    // Resolve `<rootDir>/*.md` patterns (the only shape `lib/sync.ts` uses)
    // against the virtual filesystem, returning matches in sorted order.
    mockedGlob.mockImplementation(
      async (patterns: string | string[]): Promise<string[]> => {
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

        return matches.slice().sort();
      },
    );
  });

  /**
   * Seeds the standard trio (one command, rule, and skill) under the
   * default config root so a baseline `dry-ai sync` has exactly one
   * item per kind to render. Distinct names (`my-cmd`, `my-rule`,
   * `my-skill`) avoid path collisions across agent targets (the
   * Cursor command output is skill-shaped at
   * `.cursor/skills/<name>/SKILL.md`) and let report-grouping
   * assertions verify name-per-kind placement.
   */
  function arrangeBasicSources(): void {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'my-cmd.md'),
      content: [
        '---',
        'name: my-cmd',
        'description: Test command',
        '---',
        '',
        'Command body',
        '',
      ].join('\n'),
    });

    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'my-rule.md'),
      content: [
        '---',
        'description: Test rule',
        'agents:',
        '  copilot:',
        "    applyTo: '**'",
        '  cursor:',
        "    globs: '**'",
        '---',
        '',
        'Rule body',
        '',
      ].join('\n'),
    });

    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(
        DEFAULT_CONFIG_ROOT,
        'skills',
        'my-skill',
        'SKILL.md',
      ),
      content: '# My Skill\n',
    });
  }

  /**
   * The six concrete written file paths `arrangeBasicSources()`
   * produces on a clean sync — two agents × (command + rule + skill).
   * Used by the "writes files to target roots" assertion and by the
   * "(updated)" report test, which pre-seeds each of these file paths
   * to flip the sync change type from `installed` to `updated`.
   *
   * Note: this is intentionally file-level output, not the target's
   * `outputPath` (which can be a directory for some targets).
   */
  const basicWrittenFilePaths = [
    // Command → Copilot (markdown prompt file).
    path.join(VIRTUAL_HOME_DIR, '.copilot', 'prompts', 'my-cmd.prompt.md'),
    // Command → Cursor (skill-style SKILL.md).
    path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills', 'my-cmd', 'SKILL.md'),
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
    path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills', 'my-skill', 'SKILL.md'),
    // Skill → Cursor (directory copy of the source SKILL.md).
    path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills', 'my-skill', 'SKILL.md'),
  ];

  describe('Registry contracts', () => {
    it('should keep the e2e output-tree coverage map exhaustive for every SyncAgent', () => {
      // Compile-time guard is `satisfies Record<SyncAgent, true>` on the map; this
      // keeps the value referenced so linters do not treat it as dead code.
      expect(e2eOutputTreeTestCoverageByAgent).toBeDefined();
    });

    describe('for Copilot and Cursor target trees', () => {
      it('should place command, rule, and skill files under each agent home tree (prompts, instructions, skills, rules) for the basic trio', async () => {
        const copilotTargetRoots = {
          prompts: path.join(VIRTUAL_HOME_DIR, '.copilot', 'prompts'),
          instructions: path.join(VIRTUAL_HOME_DIR, '.copilot', 'instructions'),
          skills: path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills'),
        };
        const cursorTargetRoots = {
          rules: path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules'),
          skills: path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills'),
        };
        expect(Object.keys(copilotTargetRoots).sort()).toEqual([
          'instructions',
          'prompts',
          'skills',
        ]);
        expect(Object.keys(cursorTargetRoots).sort()).toEqual([
          'rules',
          'skills',
        ]);

        arrangeBasicSources();
        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        expect(stderrMessages).toEqual([]);

        for (const filePath of buildExpectedTrioProductFilePaths(
          VIRTUAL_HOME_DIR,
        ).map((p) => path.normalize(p))) {
          expect(mockFileSystem.files.has(filePath)).toBe(true);
        }
      });

      describe('when agent is Copilot', () => {
        it('should write the command prompt and warn when the Cursor agents block is invalid', async () => {
          const fileStem = 'bad-cursor-cmd';
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_CONFIG_ROOT,
              'commands',
              `${fileStem}.md`,
            ),
            content: [
              '---',
              'name: my-cmd',
              'description: Test command',
              'agents:',
              '  copilot: {}',
              '  cursor: invalid-cursor-section',
              '---',
              '',
              'Command body',
              '',
            ].join('\n'),
          });

          const { cliOptions, stderrMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          const copilotPrompt = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            `${fileStem}.prompt.md`,
          );
          const cursorSkill = path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'my-cmd',
            'SKILL.md',
          );

          expect(mockFileSystem.files.has(copilotPrompt)).toBe(true);
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: copilotPrompt,
            }),
          ).toContain('Command body');
          expect(mockFileSystem.files.has(cursorSkill)).toBe(false);

          expect(stderrMessages).toHaveLength(1);
          expect(stripAnsi(stderrMessages.join(''))).toMatch(
            /Skipping Cursor for .*bad-cursor-cmd\.md.*agents\.cursor/s,
          );
        });
      });

      describe('when agent is Cursor', () => {
        it('should write the command skill and warn when the Copilot agents block is invalid', async () => {
          const fileStem = 'bad-copilot-cmd';
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_CONFIG_ROOT,
              'commands',
              `${fileStem}.md`,
            ),
            content: [
              '---',
              'name: my-cmd',
              'description: Test command',
              'agents:',
              '  copilot: invalid-copilot-section',
              '  cursor: {}',
              '---',
              '',
              'Command body',
              '',
            ].join('\n'),
          });

          const { cliOptions, stderrMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          const copilotPrompt = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            `${fileStem}.prompt.md`,
          );
          const cursorSkill = path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'my-cmd',
            'SKILL.md',
          );

          expect(mockFileSystem.files.has(copilotPrompt)).toBe(false);
          expect(mockFileSystem.files.has(cursorSkill)).toBe(true);
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: cursorSkill }),
          ).toContain('Command body');

          expect(stderrMessages).toHaveLength(1);
          expect(stripAnsi(stderrMessages.join(''))).toMatch(
            /Skipping Copilot for .*bad-copilot-cmd\.md.*agents\.copilot/s,
          );
        });
      });

      // priority: med
      it.todo(
        'should order the sync report and manifest by registry agent order and by item kind',
      );

      // priority: med
      it.todo(
        'should derive expected agent labels and output roots from the registry in shared helpers',
      );

      // priority: med
      it.todo(
        'should update manifest removal so each agent that lost an item drops the right rows when a source vanishes, even as the agent set grows',
      );

      // priority: med
      it.todo(
        'should show "Copilot" and "Cursor" as the per-agent report labels from the registry under Applied changes',
      );

      // priority: med
      it.todo(
        'should cover layout-specific conflicts (e.g. same Cursor path for command and skill) when the ownership model demands it',
      );

      // priority: low
      it.todo(
        'should place partial writes on the expected per-agent paths with the expected file types when one agent block is invalid and the other still syncs',
      );
    });

    describe('when the manifest references a stale or invalid registry', () => {
      // priority: med
      it.todo(
        'should fail the run with a clear error when the manifest names an agent that no longer exists',
      );
      // priority: low
      it.todo(
        'should follow registry order for Applied changes sections in stdout when agent order in the registry changes',
      );
      // priority: low
      it.todo(
        'should still render a readable report without duplicate or empty agent headings when a registry display label is missing or reused',
      );
    });
  });

  describe('Core sync: writes, discovery, and partial per-agent rules', () => {
    describe('with the default trio (command, rule, skill)', () => {
      it('should write commands, rules, and skills to every supported agent target', async () => {
        arrangeBasicSources();

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

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
        for (const writtenFilePath of basicWrittenFilePaths) {
          expect(mockFileSystem.files.has(writtenFilePath)).toBe(true);
        }
      });

      /**
       * Same contract as the baseline "writes … every supported agent
       * target" test: one sync item and outputs per source. These cases
       * use N>1 commands, rules, or skill folders to ensure discovery
       * scales (no merging, no single-item assumptions).
       */
      describe('with multiple command sources', () => {
        it('should write one output per command file under the config commands root', async () => {
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_CONFIG_ROOT,
              'commands',
              'alpha-cmd.md',
            ),
            content: [
              '---',
              'name: alpha-cmd',
              'description: Alpha command',
              '---',
              '',
              'Alpha body',
              '',
            ].join('\n'),
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'beta-cmd.md'),
            content: [
              '---',
              'name: beta-cmd',
              'description: Beta command',
              '---',
              '',
              'Beta body',
              '',
            ].join('\n'),
          });

          const { cliOptions, stderrMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          expect(stderrMessages).toEqual([]);

          const copilotAlpha = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'alpha-cmd.prompt.md',
          );
          const copilotBeta = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'beta-cmd.prompt.md',
          );
          const cursorAlpha = path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'alpha-cmd',
            'SKILL.md',
          );
          const cursorBeta = path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'beta-cmd',
            'SKILL.md',
          );

          for (const outputPath of [
            copilotAlpha,
            copilotBeta,
            cursorAlpha,
            cursorBeta,
          ]) {
            expect(mockFileSystem.files.has(outputPath)).toBe(true);
          }

          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: copilotAlpha,
            }),
          ).toContain('Alpha body');
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: copilotBeta }),
          ).toContain('Beta body');
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: cursorAlpha }),
          ).toContain('Alpha body');
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: cursorBeta }),
          ).toContain('Beta body');
        });
      });

      describe('when on-disk output drifts from the source', () => {
        describe('for command targets', () => {
          it.each([
            {
              agent: 'Copilot',
              driftPath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'my-cmd.prompt.md',
              ),
            },
            {
              agent: 'Cursor',
              driftPath: path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'skills',
                'my-cmd',
                'SKILL.md',
              ),
            },
          ] as const)(
            'should restore command output for $agent and report my-cmd as updated',
            async ({ driftPath }) => {
              arrangeBasicSources();

              const { cliOptions, stderrMessages, stdoutMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              storeMockTextFile({
                handle: mockFileSystem,
                filePath: driftPath,
                content: '# user tampered\n',
              });

              stdoutMessages.length = 0;
              stderrMessages.length = 0;

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: driftPath,
                }),
              ).toContain('Command body');
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatch(/my-cmd \(updated\)/);
            },
          );
        });

        describe('for rule targets', () => {
          it.each([
            {
              agent: 'Copilot',
              driftPath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'instructions',
                'my-rule.instructions.md',
              ),
            },
            {
              agent: 'Cursor',
              driftPath: path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'rules',
                'my-rule.mdc',
              ),
            },
          ] as const)(
            'should restore rule output for $agent and report my-rule as updated',
            async ({ driftPath }) => {
              arrangeBasicSources();

              const { cliOptions, stderrMessages, stdoutMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              storeMockTextFile({
                handle: mockFileSystem,
                filePath: driftPath,
                content: '# user tampered\n',
              });

              stdoutMessages.length = 0;
              stderrMessages.length = 0;

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: driftPath,
                }),
              ).toContain('Rule body');
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatch(/my-rule \(updated\)/);
            },
          );
        });

        describe('for directory skill targets', () => {
          it.each([
            {
              agent: 'Copilot',
              skillRoot: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'skills',
                'my-skill',
              ),
            },
            {
              agent: 'Cursor',
              skillRoot: path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'skills',
                'my-skill',
              ),
            },
          ] as const)(
            'should recopy my-skill for $agent when SKILL.md drifts and report it as updated',
            async ({ skillRoot }) => {
              arrangeBasicSources();

              const { cliOptions, stderrMessages, stdoutMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              const skillMd = path.join(skillRoot, 'SKILL.md');
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: skillMd,
                content: '# tampered skill\n',
              });

              stdoutMessages.length = 0;
              stderrMessages.length = 0;

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                readMockTextFile({ handle: mockFileSystem, filePath: skillMd }),
              ).toContain('# My Skill');
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatch(/my-skill \(updated\)/);
            },
          );

          it.each([
            {
              agent: 'Copilot',
              agentSkillsRoot: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'skills',
              ),
            },
            {
              agent: 'Cursor',
              agentSkillsRoot: path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills'),
            },
          ] as const)(
            'should recopy rich-skill for $agent when a non-SKILL.md file drifts and report it as updated',
            async ({ agentSkillsRoot }) => {
              const skillName = 'rich-skill';
              const skillSourceDir = path.join(
                DEFAULT_CONFIG_ROOT,
                'skills',
                skillName,
              );
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(skillSourceDir, 'SKILL.md'),
                content: '# Rich skill\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(skillSourceDir, 'context.md'),
                content: 'Context body\n',
              });

              const { cliOptions, stderrMessages, stdoutMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              const skillRoot = path.join(agentSkillsRoot, skillName);
              const contextPath = path.join(skillRoot, 'context.md');
              const skillMd = path.join(skillRoot, 'SKILL.md');

              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: contextPath,
                }),
              ).toContain('Context body');

              storeMockTextFile({
                handle: mockFileSystem,
                filePath: contextPath,
                content: 'user tampered\n',
              });

              stdoutMessages.length = 0;
              stderrMessages.length = 0;

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: contextPath,
                }),
              ).toContain('Context body');
              expect(
                readMockTextFile({ handle: mockFileSystem, filePath: skillMd }),
              ).toContain('Rich skill');
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatch(new RegExp(`${skillName} \\(updated\\)`));
            },
          );
        });
      });

      describe('when SKILL.md is missing but its output directory still exists', () => {
        it.each([
          {
            agent: 'Copilot',
            scenario: 'synced skill under .copilot/skills',
            skillMdPath: path.join(
              VIRTUAL_HOME_DIR,
              '.copilot',
              'skills',
              'my-skill',
              'SKILL.md',
            ),
            expectedSnippet: '# My Skill',
          },
          {
            agent: 'Cursor',
            scenario: 'command under .cursor/skills/<name>',
            skillMdPath: path.join(
              VIRTUAL_HOME_DIR,
              '.cursor',
              'skills',
              'my-cmd',
              'SKILL.md',
            ),
            expectedSnippet: 'Command body',
          },
          {
            agent: 'Cursor',
            scenario: 'synced skill under .cursor/skills',
            skillMdPath: path.join(
              VIRTUAL_HOME_DIR,
              '.cursor',
              'skills',
              'my-skill',
              'SKILL.md',
            ),
            expectedSnippet: '# My Skill',
          },
        ] as const)(
          'should recreate SKILL.md for $agent ($scenario)',
          async ({ skillMdPath, expectedSnippet }) => {
            arrangeBasicSources();

            const { cliOptions, stderrMessages } = createTestEnv({
              mockFileSystem,
            });

            await runCLI({
              argv: ['sync'],
              ...cliOptions,
            });

            expect(stderrMessages).toEqual([]);

            expect(
              mockFileSystem.files.has(normalizeMockPath(skillMdPath)),
            ).toBe(true);

            removeMockPath({ handle: mockFileSystem, targetPath: skillMdPath });

            await runCLI({
              argv: ['sync'],
              ...cliOptions,
            });

            expect(stderrMessages).toEqual([]);
            expect(
              mockFileSystem.files.has(normalizeMockPath(skillMdPath)),
            ).toBe(true);
            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: skillMdPath,
              }),
            ).toContain(expectedSnippet);
          },
        );
      });

      describe('when a synced skill directory contains files not in the source tree', () => {
        it.each([
          {
            agent: 'Copilot',
            skillRoot: path.join(
              VIRTUAL_HOME_DIR,
              '.copilot',
              'skills',
              'my-skill',
            ),
          },
          {
            agent: 'Cursor',
            skillRoot: path.join(
              VIRTUAL_HOME_DIR,
              '.cursor',
              'skills',
              'my-skill',
            ),
          },
        ] as const)(
          'should remove stray files under my-skill for $agent and report it as updated',
          async ({ skillRoot }) => {
            arrangeBasicSources();

            const { cliOptions, stderrMessages, stdoutMessages } =
              createTestEnv({ mockFileSystem });

            await runCLI({
              argv: ['sync'],
              ...cliOptions,
            });

            expect(stderrMessages).toEqual([]);

            const strayFile = path.join(skillRoot, 'user-notes.md');
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: strayFile,
              content: '# local only\n',
            });

            stdoutMessages.length = 0;
            stderrMessages.length = 0;

            await runCLI({
              argv: ['sync'],
              ...cliOptions,
            });

            expect(stderrMessages).toEqual([]);
            expect(mockFileSystem.files.has(normalizeMockPath(strayFile))).toBe(
              false,
            );
            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(skillRoot, 'SKILL.md'),
              }),
            ).toContain('# My Skill');
            const report = stripAnsi(stdoutMessages.join(''));
            expect(report).toMatch(/my-skill \(updated\)/);
          },
        );
      });

      describe('stdout after sync', () => {
        it('should print Applied changes: None on a second run when sources, manifest, and outputs stay aligned', async () => {
          arrangeBasicSources();

          const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });
          expect(stderrMessages).toEqual([]);

          stdoutMessages.length = 0;
          stderrMessages.length = 0;

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          expect(stderrMessages).toEqual([]);
          const report = stripAnsi(stdoutMessages.join(''));
          expect(report).toContain('Applied changes: None');
          expect(report).not.toContain('- Copilot');
        });
      });

      it('should write one output per rule file under the config rules root', async () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'alpha-rule.md'),
          content: [
            '---',
            'description: Test rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Alpha rule body',
            '',
          ].join('\n'),
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'beta-rule.md'),
          content: [
            '---',
            'description: Test rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Beta rule body',
            '',
          ].join('\n'),
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        expect(stderrMessages).toEqual([]);

        const copilotAlpha = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'instructions',
          'alpha-rule.instructions.md',
        );
        const copilotBeta = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'instructions',
          'beta-rule.instructions.md',
        );
        const cursorAlpha = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'rules',
          'alpha-rule.mdc',
        );
        const cursorBeta = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'rules',
          'beta-rule.mdc',
        );

        for (const outputPath of [
          copilotAlpha,
          copilotBeta,
          cursorAlpha,
          cursorBeta,
        ]) {
          expect(mockFileSystem.files.has(outputPath)).toBe(true);
        }

        expect(
          readMockTextFile({ handle: mockFileSystem, filePath: copilotAlpha }),
        ).toContain('Alpha rule body');
        expect(
          readMockTextFile({ handle: mockFileSystem, filePath: copilotBeta }),
        ).toContain('Beta rule body');
        expect(
          readMockTextFile({ handle: mockFileSystem, filePath: cursorAlpha }),
        ).toContain('Alpha rule body');
        expect(
          readMockTextFile({ handle: mockFileSystem, filePath: cursorBeta }),
        ).toContain('Beta rule body');
      });

      it('should copy one output tree per skill directory under the config skills root', async () => {
        // Each skill is a directory copy (see `copyDirectoryContents` in
        // `lib/sync.ts`): every file in the source folder — not only
        // `SKILL.md` — is mirrored under each agent's skills target.
        for (const [skillName, body, extraBody] of [
          [
            'alpha-skill',
            '# Alpha skill\n',
            'Alpha supporting file\n',
          ] as const,
          ['beta-skill', '# Beta skill\n', 'Beta supporting file\n'] as const,
        ]) {
          const skillDir = path.join(DEFAULT_CONFIG_ROOT, 'skills', skillName);
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(skillDir, 'SKILL.md'),
            content: body,
          });
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(skillDir, 'context.md'),
            content: extraBody,
          });
        }

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        expect(stderrMessages).toEqual([]);

        const expectedOutputRelFiles = ['SKILL.md', 'context.md'] as const;
        for (const agentRoot of [
          path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills'),
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills'),
        ]) {
          for (const skillName of ['alpha-skill', 'beta-skill'] as const) {
            for (const fileName of expectedOutputRelFiles) {
              expect(
                mockFileSystem.files.has(
                  path.join(agentRoot, skillName, fileName),
                ),
              ).toBe(true);
            }
          }
        }

        const copilotAlphaSkill = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'skills',
          'alpha-skill',
          'SKILL.md',
        );
        const copilotAlphaContext = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'skills',
          'alpha-skill',
          'context.md',
        );
        const cursorBetaContext = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'skills',
          'beta-skill',
          'context.md',
        );

        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: copilotAlphaSkill,
          }),
        ).toContain('Alpha skill');
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: copilotAlphaContext,
          }),
        ).toBe('Alpha supporting file\n');
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: cursorBetaContext,
          }),
        ).toBe('Beta supporting file\n');
      });

      it('should write the Copilot rule file and warn when the Cursor agents block is invalid', async () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(
            DEFAULT_CONFIG_ROOT,
            'rules',
            'bad-cursor-block.md',
          ),
          content: [
            '---',
            'description: Test rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor: invalid-cursor-section',
            '---',
            '',
            'Body',
            '',
          ].join('\n'),
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const copilotPath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'instructions',
          'bad-cursor-block.instructions.md',
        );
        const cursorPath = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'rules',
          'bad-cursor-block.mdc',
        );

        expect(mockFileSystem.files.has(copilotPath)).toBe(true);
        expect(mockFileSystem.files.has(cursorPath)).toBe(false);
        expect(stderrMessages).toHaveLength(1);
        expect(stripAnsi(stderrMessages.join(''))).toMatch(
          /Skipping Cursor for .*bad-cursor-block\.md/,
        );
      });

      it('should write the Cursor rule file when alwaysApply is true and globs is omitted', async () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(
            DEFAULT_CONFIG_ROOT,
            'rules',
            'cursor-always-apply.md',
          ),
          content: [
            '---',
            'description: Cursor always-apply rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            '    alwaysApply: true',
            '---',
            '',
            'Body',
            '',
          ].join('\n'),
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const cursorPath = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'rules',
          'cursor-always-apply.mdc',
        );

        expect(mockFileSystem.files.has(cursorPath)).toBe(true);
        expect(stderrMessages).toEqual([]);
      });

      it('should write the Cursor rule file and warn when the Copilot agents block is invalid', async () => {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(
            DEFAULT_CONFIG_ROOT,
            'rules',
            'bad-copilot-block.md',
          ),
          content: [
            '---',
            'description: Test rule',
            'agents:',
            '  copilot: invalid-copilot-section',
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Body',
            '',
          ].join('\n'),
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const copilotPath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'instructions',
          'bad-copilot-block.instructions.md',
        );
        const cursorPath = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'rules',
          'bad-copilot-block.mdc',
        );

        expect(mockFileSystem.files.has(cursorPath)).toBe(true);
        expect(mockFileSystem.files.has(copilotPath)).toBe(false);
        expect(stderrMessages).toHaveLength(1);
        expect(stripAnsi(stderrMessages.join(''))).toMatch(
          /Skipping Copilot for .*bad-copilot-block\.md/,
        );
      });

      // priority: med
      it.todo(
        'should print the resolved output root in stdout when --output-root is set, and stay silent otherwise',
      );

      // priority: med
      it.todo(
        'should print the resolved output root in stdout when --test is set',
      );
    });

    describe('when home agent trees are missing (first run)', () => {
      it('should create every target root directory on disk before writing outputs', async () => {
        // Arrange: sources exist under the default config root, but the mock
        // has no pre-seeded `~/.copilot` / `~/.cursor` target trees. Sync must
        // call `ensureTargetDirectories` (see `lib/sync.ts`) so later writes
        // and copies do not see missing parents — the mock `writeFile` even
        // fails if a parent directory was never created via `makeDirectory`.
        arrangeBasicSources();

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        // Expected output roots for the default `~` layout (Copilot: prompts,
        // instructions, skills; Cursor: rules, skills) — fixed here so the
        // test does not call product code to compute the oracle.
        const expectedTargetRoots = [
          path.join(VIRTUAL_HOME_DIR, '.copilot', 'prompts'),
          path.join(VIRTUAL_HOME_DIR, '.copilot', 'instructions'),
          path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills'),
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules'),
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills'),
        ].map((dirPath) => path.normalize(dirPath));

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        expect(stderrMessages).toEqual([]);

        for (const root of expectedTargetRoots) {
          expect(mockFileSystem.directories.has(root)).toBe(true);
        }

        for (const writtenFilePath of basicWrittenFilePaths) {
          expect(mockFileSystem.files.has(writtenFilePath)).toBe(true);
        }
      });
    });

    describe('partial configs', () => {
      // priority: med
      it.todo(
        'should sync only command outputs and write no rule or skill files when the config has commands but no rules or skills',
      );

      // priority: med
      it.todo(
        'should sync only rule outputs and write no command or skill files when the config has rules but no commands or skills',
      );

      // priority: med
      it.todo(
        'should sync only skill copies and write no command or rule files when the config has skills but no commands or rules',
      );

      // priority: med
      it.todo('should leave outputs unchanged when the config root is empty');
    });

    describe('source discovery', () => {
      // priority: med
      it.todo(
        'should ignore non-.md files under the commands and rules source roots',
      );

      // priority: med
      it.todo(
        'should discover command and rule files only at the top level of each source root, not in nested subdirectories',
      );
    });

    describe('write and filesystem errors', () => {
      // priority: med
      it.todo(
        'should surface filesystem errors from writing a target file instead of swallowing them',
      );
    });
  });

  describe('Sync report', () => {
    describe('structure, change types, and conflict footer', () => {
      it('should group applied items by agent and by kind under Applied changes', async () => {
        // Arrange: fresh trio means each item renders once per agent,
        // letting us verify the header, agent ordering, and
        // kind-per-agent grouping without also pinning down the
        // change-type label (covered by the sibling tests below).
        arrangeBasicSources();

        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const report = stripAnsi(stdoutMessages.join(''));

        // Sanity: top-level heading renders and no warnings fired.
        expect(report).toContain('Applied changes:');
        expect(stderrMessages).toEqual([]);

        // Agent sections render in registry definition order
        // (Copilot → Cursor). Slicing between the two agent headings
        // yields a clean per-agent block.
        const copilotStart = report.indexOf('- Copilot');
        const cursorStart = report.indexOf('- Cursor');
        expect(copilotStart).toBeGreaterThan(-1);
        expect(cursorStart).toBeGreaterThan(copilotStart);

        // Within each agent block, kind headings render in
        // commands → rules → skills order, and each item name appears
        // under its own kind heading. Catches regressions that
        // mis-group items across sections.
        for (const section of [
          report.slice(copilotStart, cursorStart),
          report.slice(cursorStart),
        ]) {
          const commandsIdx = section.indexOf('* commands');
          const rulesIdx = section.indexOf('* rules');
          const skillsIdx = section.indexOf('* skills');

          expect(commandsIdx).toBeGreaterThan(-1);
          expect(rulesIdx).toBeGreaterThan(commandsIdx);
          expect(skillsIdx).toBeGreaterThan(rulesIdx);

          expect(section.slice(commandsIdx, rulesIdx)).toContain('my-cmd');
          expect(section.slice(rulesIdx, skillsIdx)).toContain('my-rule');
          expect(section.slice(skillsIdx)).toContain('my-skill');
        }
      });

      it('should tag newly-written items with change-type "(installed)"', async () => {
        // Arrange: fresh sources, no pre-existing outputs. Every
        // write is a new file, so the report should tag every item
        // `(installed)` (see `changeType` assignment in
        // `src/lib/sync.ts`).
        arrangeBasicSources();

        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const report = stripAnsi(stdoutMessages.join(''));

        expect(report).toMatch(/my-cmd \(installed\)/);
        expect(report).toMatch(/my-rule \(installed\)/);
        expect(report).toMatch(/my-skill \(installed\)/);

        // Guard against false positives: no applied item should be
        // reported as `updated` when all outputs are brand-new.
        expect(report).not.toMatch(/my-cmd \(updated\)/);
        expect(report).not.toMatch(/my-rule \(updated\)/);
        expect(report).not.toMatch(/my-skill \(updated\)/);

        expect(stderrMessages).toEqual([]);
      });

      it('should tag items with (updated) when each output path already exists before sync', async () => {
        // Arrange: same sources as the `(installed)` case, but
        // pre-seed every target-root output on disk. Sync branches
        // to `updated` when the output path already exists (see
        // `changeType` assignment in `src/lib/sync.ts`).
        arrangeBasicSources();

        for (const writtenFilePath of basicWrittenFilePaths) {
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: writtenFilePath,
            content: '# pre-existing\n',
          });
        }

        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const report = stripAnsi(stdoutMessages.join(''));

        expect(report).toMatch(/my-cmd \(updated\)/);
        expect(report).toMatch(/my-rule \(updated\)/);
        expect(report).toMatch(/my-skill \(updated\)/);

        // Guard: nothing should be tagged `installed` when every
        // output pre-existed.
        expect(report).not.toMatch(/my-cmd \(installed\)/);
        expect(report).not.toMatch(/my-rule \(installed\)/);
        expect(report).not.toMatch(/my-skill \(installed\)/);

        expect(stderrMessages).toEqual([]);
      });

      it('should tag pruned items with (removed) when the source is gone but the manifest still lists outputs', async () => {
        // Arrange: no current sources. Prior manifest claims an
        // earlier sync wrote `gone-cmd` outputs for both agents;
        // since those sources are gone, the prune path turns every
        // manifest entry into a removal (see `removeStaleOutputs` in
        // `src/lib/sync.ts`).
        //
        // Kept here (alongside `installed`/`updated`) so the full
        // change-type label vocabulary is co-located in one describe.
        // The pruning suite's equivalent test covers the same shape
        // from the prune path's POV.
        const copilotOutputPath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'prompts',
          'gone-cmd.prompt.md',
        );
        const cursorOutputDir = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'skills',
          'gone-cmd',
        );
        const cursorWritePath = path.join(cursorOutputDir, 'SKILL.md');

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: copilotOutputPath,
          content: '# stale prompt\n',
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: cursorWritePath,
          content: '# stale skill\n',
        });

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
          content: JSON.stringify({
            version: MOCK_SYNC_MANIFEST_VERSION,
            outputs: [
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
                // Real sync stores the skill directory on Cursor commands; `SKILL.md` is the writePath only.
                outputPath: cursorOutputDir,
              },
            ],
          }),
        });

        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const report = stripAnsi(stdoutMessages.join(''));

        // Both agents tracked `gone-cmd`, so each agent section
        // should render its own `(removed)` line for it.
        const removedMatches = report.match(/gone-cmd \(removed\)/g) ?? [];
        expect(removedMatches).toHaveLength(2);

        expect(stderrMessages).toEqual([]);
      });

      it('should print Skipped conflicts: None when no items were skipped for conflicts', async () => {
        // Arrange: baseline sources + no pre-existing conflicts
        // means nothing gets skipped. The report should close with
        // the `None` footer branch (see `renderSyncReport` in
        // `src/lib/sync.ts`). Text is asserted after stripAnsi; chalk
        // color (e.g. green for this line) is not under test here.
        arrangeBasicSources();

        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        const report = stripAnsi(stdoutMessages.join(''));

        expect(report).toContain('Skipped conflicts: None');
        expect(stderrMessages).toEqual([]);
      });
    });

    describe('edge cases and errors', () => {
      // priority: med
      it.todo(
        'should still render a coherent report with a possibly empty Applied changes and a non-empty Skipped conflicts when every item is skipped for conflicts',
      );
      // priority: med
      it.todo(
        'should list only (removed) lines for pruned work and no spurious (installed) lines when the run only removes stale manifest outputs',
      );
      // priority: med
      it.todo(
        'should keep section spacing and group headings stable when one item kind (e.g. rules) has no output but other kinds do',
      );
      // priority: low
      it.todo(
        'should let report emission errors fail the run when the logger or string builder throws',
      );
      // priority: low
      it.todo(
        'should keep structural report text free of raw ANSI escape bytes when styles add color or emphasis',
      );
    });
  });

  describe('Sync manifest', () => {
    describe('create and update', () => {
      it('should create sync-manifest.json with expected rows on the first run when none exists', async () => {
        const manifestPath = path.join(
          DEFAULT_CONFIG_ROOT,
          'sync-manifest.json',
        );
        expect(mockFileSystem.files.has(manifestPath)).toBe(false);

        arrangeBasicSources();
        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        expect(stderrMessages).toEqual([]);
        expect(mockFileSystem.files.has(manifestPath)).toBe(true);
        assertMockSyncManifestMatchesTrio(
          mockFileSystem,
          DEFAULT_CONFIG_ROOT,
          VIRTUAL_HOME_DIR,
        );
      });

      it('should add manifest rows for a new command when its file appears and sync runs again', async () => {
        arrangeBasicSources();
        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });
        const manifestPath = path.join(
          DEFAULT_CONFIG_ROOT,
          'sync-manifest.json',
        );

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        const afterFirst = readMockTextFile({
          handle: mockFileSystem,
          filePath: manifestPath,
        });
        assertMockSyncManifestMatchesTrio(
          mockFileSystem,
          DEFAULT_CONFIG_ROOT,
          VIRTUAL_HOME_DIR,
        );
        const parsedFirst = mockSyncManifestSchema.parse(
          JSON.parse(afterFirst),
        );
        expect(parsedFirst.outputs).toHaveLength(6);

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'extra-cmd.md'),
          content: [
            '---',
            'name: extra-cmd',
            'description: Extra command',
            '---',
            '',
            'Extra body',
            '',
          ].join('\n'),
        });
        // `extra-cmd.md` → stem `extra-cmd`; frontmatter `name` matches the stem in this fixture.

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        const afterSecond = readMockTextFile({
          handle: mockFileSystem,
          filePath: manifestPath,
        });
        expect(JSON.parse(afterFirst)).not.toEqual(JSON.parse(afterSecond));

        const expected = [
          ...buildExpectedManifestTrio(VIRTUAL_HOME_DIR),
          ...buildExpectedManifestCommandRows(VIRTUAL_HOME_DIR, {
            commandName: 'extra-cmd',
            sourceFileStem: 'extra-cmd',
          }),
        ];
        assertMockSyncManifestMatchesExpectedRows(
          mockFileSystem,
          DEFAULT_CONFIG_ROOT,
          expected,
        );
        const parsedSecond = mockSyncManifestSchema.parse(
          JSON.parse(afterSecond),
        );
        expect(parsedSecond.outputs).toHaveLength(8);
      });

      // priority: med
      it.todo(
        'should list manifest entries in deterministic order by agent, kind, name, and outputPath when writing sync-manifest.json',
      );
    });

    describe('pruning stale manifest outputs', () => {
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
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'current.md'),
          content: [
            '---',
            'name: current',
            'description: Still-present command',
            '---',
            '',
            'Current body',
            '',
          ].join('\n'),
        });
      }

      /**
       * Writes the prior `sync-manifest.json` (version 2) to the config
       * root with the given stale entries — i.e. entries whose
       * `outputPath` is no longer claimed by any current source, so
       * `collectRemovedManifestEntries` will mark them as orphaned and
       * `removeStaleOutputs` will `fs.remove` them.
       */
      function seedPriorManifest(staleEntries: StaleManifestEntry[]): void {
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
          content: JSON.stringify({
            version: MOCK_SYNC_MANIFEST_VERSION,
            outputs: staleEntries,
          }),
        });
      }

      /**
       * Arranges a stale `command` named `gone-cmd` — seeds its on-disk
       * outputs (Copilot: prompt file; Cursor: `SKILL.md` under the skill
       * directory) and the prior manifest entries. For Cursor, the
       * manifest’s `outputPath` is the directory (matching real sync: the
       * target’s `outputPath` is the folder, `writePath` is `SKILL.md`).
       */
      function arrangeStaleCommand(): {
        copilotOutputPath: string;
        cursorOutputDir: string;
        cursorWritePath: string;
      } {
        const copilotOutputPath = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'prompts',
          'gone-cmd.prompt.md',
        );
        const cursorOutputDir = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'skills',
          'gone-cmd',
        );
        const cursorWritePath = path.join(cursorOutputDir, 'SKILL.md');

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: copilotOutputPath,
          content: '# stale prompt\n',
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: cursorWritePath,
          content: '# stale skill\n',
        });

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
            outputPath: cursorOutputDir,
          },
        ]);

        return { copilotOutputPath, cursorOutputDir, cursorWritePath };
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

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: copilotOutputPath,
          content: '# stale instructions\n',
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: cursorOutputPath,
          content: '# stale mdc\n',
        });

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
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: filePath,
            content: `# stale ${path.basename(filePath)}\n`,
          });
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

      it('should remove per-agent outputs for a manifest-tracked command whose source no longer exists under the config root', async () => {
        // Arrange: prior manifest tracks `gone-cmd` outputs whose
        // command source is no longer present; one current command
        // (`current`) keeps the run from being a pure-prune scenario.
        seedCurrentCommandSource();
        const { copilotOutputPath, cursorWritePath } = arrangeStaleCommand();
        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        // Sanity check: the stale outputs were actually seeded on disk
        // before the run, so a `false` post-run assertion isn't trivially
        // true (e.g. due to a bad path in `arrangeStaleCommand`).
        expect(mockFileSystem.files.has(copilotOutputPath)).toBe(true);
        expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: both stale per-agent command outputs were pruned.
        expect(mockFileSystem.files.has(copilotOutputPath)).toBe(false);
        expect(mockFileSystem.files.has(cursorWritePath)).toBe(false);

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

      it('should remove per-agent outputs for a manifest-tracked rule whose source no longer exists under the config root', async () => {
        // Arrange: prior manifest tracks `gone-rule` outputs (Copilot
        // `.instructions.md` + Cursor `.mdc`) whose rule source is no
        // longer present; one current command keeps the apply phase
        // exercised.
        seedCurrentCommandSource();
        const { copilotOutputPath, cursorOutputPath } = arrangeStaleRule();
        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

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

      it('should remove entire per-agent skill output trees for a manifest-tracked skill whose source directory no longer exists under the config root', async () => {
        // Arrange: prior manifest tracks `gone-skill` directory
        // outputs; multiple files seeded inside each agent's skill
        // directory let us assert the full subtree is pruned, not just
        // a top-level file at the manifest's `outputPath`.
        seedCurrentCommandSource();
        const { copilotInnerFiles, cursorInnerFiles } = arrangeStaleSkill();
        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

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

      it('should leave files under target roots that were never manifest-listed unchanged while pruning stale outputs', async () => {
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
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: untrackedFilePath,
          content: untrackedFileContent,
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

        // Act
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });

        // Assert: the untracked file is still on disk with its original
        // bytes — sync must not touch outputs it didn't manage.
        expect(mockFileSystem.files.has(untrackedFilePath)).toBe(true);
        expect(
          readMockTextFile({
            handle: mockFileSystem,
            filePath: untrackedFilePath,
          }),
        ).toBe(untrackedFileContent);

        // Assert: clean run, no warnings.
        expect(stderrMessages).toEqual([]);
      });

      it('should list pruned items as removed in each agent section when apply and removal both occur', async () => {
        // Arrange: reuse the command-prune setup so the report has both
        // applied (`current`) and removed (`gone-cmd`) entries to
        // render under each agent. The kind under test here is the
        // report rendering, not the prune path itself — `command` is
        // sufficient since the report code is uniform across kinds.
        seedCurrentCommandSource();
        arrangeStaleCommand();
        const { cliOptions, stdoutMessages, stderrMessages } = createTestEnv({
          mockFileSystem,
        });

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

      describe('when the prior sync-manifest.json is not strictly valid', () => {
        it('should warn but not prune stale outputs when sync-manifest.json fails strict validation (fallback manifest is empty)', async () => {
          seedCurrentCommandSource();
          const { copilotOutputPath, cursorWritePath, cursorOutputDir } =
            arrangeStaleCommand();

          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
            content: JSON.stringify({
              version: 999,
              outputs: [
                {
                  agent: 'copilot',
                  kind: 'command',
                  name: 'gone-cmd',
                  outputPath: copilotOutputPath,
                  contentHash: 'ignored-for-pruning',
                },
                {
                  agent: 'cursor',
                  kind: 'command',
                  name: 'gone-cmd',
                  outputPath: cursorOutputDir,
                },
              ],
            }),
          });

          const { cliOptions, stderrMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          // `loadSyncManifest` drops malformed rows after warning; with no
          // recovered prior outputs, prune targets are unknown — stale files stay.
          expect(mockFileSystem.files.has(copilotOutputPath)).toBe(true);
          expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);
          expect(stderrMessages).toHaveLength(1);
          expect(stripAnsi(stderrMessages.join(''))).toMatch(
            /did not match the expected layout/i,
          );
        });

        it('should warn and skip pruning when sync-manifest.json is not valid JSON', async () => {
          seedCurrentCommandSource();
          const { copilotOutputPath, cursorWritePath } = arrangeStaleCommand();
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
            content: '{ not json',
          });

          const { cliOptions, stderrMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          expect(mockFileSystem.files.has(copilotOutputPath)).toBe(true);
          expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);
          expect(stderrMessages).toHaveLength(1);
          expect(stripAnsi(stderrMessages.join(''))).toMatch(
            /damaged or incomplete/i,
          );
        });

        it('should fail when sync-manifest.json references an unknown agent id', async () => {
          seedCurrentCommandSource();
          const { copilotOutputPath, cursorWritePath } = arrangeStaleCommand();
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
            content: JSON.stringify({
              version: MOCK_SYNC_MANIFEST_VERSION,
              outputs: [
                {
                  agent: 'nope',
                  kind: 'command',
                  name: 'gone-cmd',
                  outputPath: copilotOutputPath,
                },
              ],
            }),
          });

          const { cliOptions } = createTestEnv({ mockFileSystem });

          await expect(
            runCLI({
              argv: ['sync'],
              ...cliOptions,
            }),
          ).rejects.toThrow(/unregistered agent "nope"/);

          expect(mockFileSystem.files.has(copilotOutputPath)).toBe(true);
          expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);
        });

        it('should warn when strict validation fails and manifest outputs is empty', async () => {
          seedCurrentCommandSource();
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
            content: JSON.stringify({
              version: 999,
              outputs: [],
            }),
          });

          const { cliOptions, stderrMessages } = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...cliOptions,
          });

          expect(stderrMessages).toHaveLength(1);
          expect(stripAnsi(stderrMessages.join(''))).toMatch(
            /did not match the expected layout/i,
          );
        });
      });
    });
  });

  describe('Ownership conflicts', () => {
    describe('namespace collisions and skipped items', () => {
      // priority: med
      it.todo(
        'should skip two commands with the same frontmatter name and list both under Skipped conflicts when their outputs collide (same Cursor path; Copilot still differs by stem)',
      );

      // priority: med
      it.todo(
        'should skip the Cursor command and skill when they share a name and output namespace and that causes a conflict',
      );

      // priority: med
      it.todo(
        'should still sync every non-conflicting item when some other items are skipped for conflicts',
      );

      // priority: low
      it.todo(
        'should list skipped conflict lines in alphabetical order by source item label',
      );

      // priority: low
      it.todo(
        'should keep manifest entries for conflict-skipped items when merge rules require it for this run',
      );

      // priority: med
      it.todo(
        'should not delete an old output for a conflict-skipped item when that path would otherwise be pruned for a missing source',
      );
    });

    describe('invariant and collector errors', () => {
      // priority: low
      it.todo(
        'should fail the run with an unhandled error when ownership-key building throws on an unexpected kind/name/path combination',
      );
      // priority: low
      it.todo(
        'should define behavior when conflict filtering receives malformed items such as empty targets',
      );
    });
  });

  describe('Frontmatter validation', () => {
    // Skills: sync copies trees and does not parse SKILL.md like command/rule
    // markdown; other commands may validate skills.

    // priority: med
    it.todo(
      'should skip a command and log a clear message when its top-level frontmatter fails validation',
    );

    // priority: med
    it.todo(
      'should skip a rule and log a clear message when its top-level frontmatter fails validation',
    );

    // priority: med
    it.todo(
      'should keep syncing the rest of the project after one invalid command or rule file is skipped for frontmatter',
    );

    // priority: med
    it.todo(
      'should skip a command and show agent-scoped issues when a per-agent block fails validation',
    );

    // priority: med
    it.todo(
      'should skip a rule and show agent-scoped issues when a per-agent block fails validation',
    );

    // priority: low
    it.todo(
      'should skip a command and name unknown agents as Unsupported agent when the agents block names an unregistered id',
    );

    // priority: low
    it.todo(
      'should skip a rule and name unknown agents as Unsupported agent when the agents block names an unregistered id',
    );

    describe('read and validation failures', () => {
      // priority: med
      it.todo(
        'should surface a read error for a discovered file when the filesystem returns failure, instead of treating it as a normal skip',
      );
      // priority: med
      it.todo(
        'should follow the warn/skip contract with no partial outputs when frontmatter parses but validation fails for that file',
      );
      // priority: low
      it.todo(
        'should follow one clear user-visible contract for a command or rule file with no closing frontmatter delimiter',
      );
      // priority: low
      it.todo(
        'should either write only frontmatter or skip with documented behavior for a command whose body is empty after trim',
      );
    });
  });

  describe('Output, rendering, and skills', () => {
    describe('per-agent output paths', () => {
      // priority: med
      it.todo(
        'should place Copilot command, rule, and skill files under the expected Copilot layout',
      );

      // priority: med
      it.todo(
        'should place Cursor command, rule, and skill files under the expected Cursor layout',
      );

      // priority: med
      it.todo(
        'should write agent-specific output that reflects valid per-agent frontmatter when the agents section is set',
      );
    });

    describe('rendered markdown output', () => {
      // Commands and rules are written as new markdown (YAML + body). Skills are
      // copied as directories, so a skill’s on-disk frontmatter is unchanged by sync.

      it('should write Copilot command files as YAML, a closing delimiter, and a trimmed body', async () => {
        const rawSource = [
          '---',
          'name: fmt-cmd',
          'description: A command for render assertions',
          '---',
          '',
          '',
          '  \n  Inner command body.  \n  ',
          '\n',
        ].join('\n');

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'fmt-cmd.md'),
          content: rawSource,
        });

        // Golden: re-serialized frontmatter and trimmed body the Copilot prompt should match.
        const expectedCopilotCommandRender = [
          '---',
          'name: fmt-cmd',
          'description: A command for render assertions',
          '---',
          'Inner command body.',
          '',
        ].join('\n');

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        const written = readMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'fmt-cmd.prompt.md',
          ),
        });
        expect(written).toBe(expectedCopilotCommandRender);
      });

      it('should write Copilot rule files as YAML, a closing delimiter, and a trimmed body', async () => {
        const rawSource = [
          '---',
          'description: A rule for render assertions',
          'agents:',
          '  copilot:',
          "    applyTo: '**'",
          '  cursor:',
          "    globs: '**'",
          '---',
          '',
          '\n\n',
          '  \n  Inner rule body.\n  Second line.  \n  ',
          '\n',
        ].join('\n');

        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'fmt-rule.md'),
          content: rawSource,
        });

        // Golden: re-serialized frontmatter and trimmed body the Copilot rule file should match.
        const expectedCopilotRuleRender = [
          '---',
          'description: A rule for render assertions',
          "applyTo: '**'",
          '---',
          'Inner rule body.',
          '  Second line.',
          '',
        ].join('\n');

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        const written = readMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'instructions',
            'fmt-rule.instructions.md',
          ),
        });
        expect(written).toBe(expectedCopilotRuleRender);
      });

      // priority: med
      it.todo(
        'should omit frontmatter keys that have no resolved value in the YAML block (no placeholder null lines)',
      );
    });

    describe('rule: Copilot and Cursor `agents` blocks', () => {
      // priority: med
      it.todo(
        'should put Copilot rule fields (e.g. applyTo) in the written instructions file with defaults when a field is omitted',
      );

      // priority: med
      it.todo(
        'should put Cursor rule fields (e.g. globs, alwaysApply) in the written rule file, including when globs imply always-apply and when alwaysApply is set explicitly',
      );
    });

    describe('skill directory copy semantics', () => {
      it('should mirror every file and nested path from a skill source into each agent skill target directory', async () => {
        const skillName = 'tree-skill';
        const skillRoot = path.join(DEFAULT_CONFIG_ROOT, 'skills', skillName);
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(skillRoot, 'SKILL.md'),
          content: '# Tree skill\n',
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(skillRoot, 'extra.txt'),
          content: 'Extra at root\n',
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(skillRoot, 'nested', 'deep.txt'),
          content: 'Nested file\n',
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        const expectedRelPaths = [
          'SKILL.md',
          'extra.txt',
          path.join('nested', 'deep.txt'),
        ] as const;
        for (const agentSkillsRoot of [
          path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills'),
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills'),
        ]) {
          const targetDir = path.join(agentSkillsRoot, skillName);
          for (const rel of expectedRelPaths) {
            const outPath = path.join(targetDir, rel);
            expect(mockFileSystem.files.has(outPath)).toBe(true);
          }
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(targetDir, 'SKILL.md'),
            }),
          ).toBe('# Tree skill\n');
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(targetDir, 'extra.txt'),
            }),
          ).toBe('Extra at root\n');
          expect(
            readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(targetDir, 'nested', 'deep.txt'),
            }),
          ).toBe('Nested file\n');
        }
      });

      it('should remove a file from every agent skill copy when that file disappears from the source and sync runs again', async () => {
        const skillName = 'prune-skill';
        const skillRoot = path.join(DEFAULT_CONFIG_ROOT, 'skills', skillName);
        const orphanSource = path.join(skillRoot, 'orphan.txt');
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(skillRoot, 'SKILL.md'),
          content: '# Prune\n',
        });
        storeMockTextFile({
          handle: mockFileSystem,
          filePath: orphanSource,
          content: 'Remove me\n',
        });

        const { cliOptions, stderrMessages } = createTestEnv({
          mockFileSystem,
        });
        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        const copilotOrphan = path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'skills',
          skillName,
          'orphan.txt',
        );
        const cursorOrphan = path.join(
          VIRTUAL_HOME_DIR,
          '.cursor',
          'skills',
          skillName,
          'orphan.txt',
        );
        for (const p of [copilotOrphan, cursorOrphan]) {
          expect(mockFileSystem.files.has(p)).toBe(true);
        }

        const normalizedOrphanSource = normalizeMockPath(orphanSource);
        expect(mockFileSystem.files.has(normalizedOrphanSource)).toBe(true);
        deleteMockTextFile({ handle: mockFileSystem, filePath: orphanSource });
        expect(mockFileSystem.files.has(normalizedOrphanSource)).toBe(false);

        await runCLI({
          argv: ['sync'],
          ...cliOptions,
        });
        expect(stderrMessages).toEqual([]);

        for (const p of [copilotOrphan, cursorOrphan]) {
          expect(mockFileSystem.files.has(p)).toBe(false);
        }
        for (const p of [
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'skills',
            skillName,
            'SKILL.md',
          ),
          path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            skillName,
            'SKILL.md',
          ),
        ]) {
          expect(mockFileSystem.files.has(p)).toBe(true);
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: p }),
          ).toBe('# Prune\n');
        }
      });
    });

    describe('write and copy errors', () => {
      // priority: med
      it.todo(
        'should surface write failures when persisting a generated command or rule file instead of continuing silently',
      );
      // priority: med
      it.todo(
        'should surface emptyDir or copy failures when applying a directory skill target (empty destination first, then copy, in that order)',
      );
      // priority: med
      it.todo(
        'should surface ensureDir failures when a parent directory cannot be created before a write or copy',
      );
      // priority: low
      it.todo(
        'should match the copy layer error when a skill source directory is missing at copy time',
      );
      // priority: low
      it.todo(
        'should surface copy or write failures for symlinked or read-only targets under the output root',
      );
    });
  });

  describe('CLI and environment', () => {
    // priority: med
    it.todo(
      'should read sources from the absolute config root and write under the default home output tree for dry-ai sync --config-root, unless --output-root or --test overrides it',
    );
    // priority: med
    it.todo(
      'should write outputs to ./output-test (relative to cwd) for --test while still reading config from the default or --config-root path',
    );
    // priority: med
    it.todo(
      'should place all agent trees under --output-root while keeping the manifest under the config root when that flag is set',
    );
    // priority: med
    it.todo(
      'should print Generated output written to the resolved path when --test or --output-root changes the output root, matching the in-memory output root value',
    );
    // priority: low
    it.todo(
      'should expand a leading ~ in --config-root and --output-root to the user home directory the same way as the rest of the CLI',
    );

    describe('commander and config root errors', () => {
      // priority: med
      it.todo(
        'should fail dry-ai sync with a commander unknownOption error when an unsupported flag (e.g. --bogus) is passed',
      );

      // priority: med
      it.todo(
        'should throw or exit with a clear error when the config root path does not exist on disk',
      );
    });
  });
});
