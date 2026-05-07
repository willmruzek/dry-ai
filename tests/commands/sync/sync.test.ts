import os from 'node:os';
import path from 'node:path';

import { loadFeature, describeFeature } from '@amiceli/vitest-cucumber';
import { CommanderError } from 'commander';
import { glob } from 'glob';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runCLI, type CLIOptions } from '../../../src/cli.js';
import type { SyncAgent } from '../../../src/lib/agents.js';

import {
  DEFAULT_CONFIG_ROOT,
  type MockFileSystemHandle,
  VIRTUAL_HOME_DIR,
  clearMockFileSystemFailures,
  configureMockFileSystem,
  configureMockOs,
  createMockFileSystemState,
  createTestEnv,
  deleteMockTextFile,
  mockFailCopyDest,
  mockFailMakeDirectory,
  mockFailReadFileString,
  mockFailRemove,
  mockFailWriteFile,
  normalizeMockPath,
  readMockTextFile,
  removeMockPath,
  storeMockTextFile,
} from '../../helpers.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(),
    tmpdir: vi.fn(),
  },
}));

async function runCLIExpectingError(
  input: { argv: string[] } & CLIOptions,
): Promise<CommanderError> {
  try {
    await runCLI({
      ...input,
      exitOverride: true,
    });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected CLI to fail.');
}

// `lib/sync.ts` uses `glob` to discover command/rule markdown files; mock it
// so sync discovers files seeded into our virtual filesystem instead of
// reading the real disk.
vi.mock('glob', () => ({
  glob: vi.fn(),
}));

const mockedOs = vi.mocked(os);
const mockedGlob = vi.mocked(glob);

/**
 * Exhaustive `Record<SyncAgent, …>`: `satisfies` requires a key for every registry
 * agent or TypeScript fails at compile time.
 */
const e2eOutputTreeTestCoverageByAgent = {
  copilot: true,
  cursor: true,
} satisfies Record<SyncAgent, true>;

let mockFileSystem: MockFileSystemHandle;

function installSyncTestGlobMock(): void {
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
}

function resetDryAiSyncTestFixtures(): void {
  mockFileSystem = createMockFileSystemState();
  clearMockFileSystemFailures(mockFileSystem);
  configureMockFileSystem({ handle: mockFileSystem });
  configureMockOs({
    mockedOs: mockedOs,
    homeDir: VIRTUAL_HOME_DIR,
    tmpDir: '/virtual/tmp',
  });
  installSyncTestGlobMock();
}

/**
 * Seeds the standard trio (one command, rule, and skill) under the
 * default config root so a baseline `dry-ai sync` has exactly one
 * item per kind to render.
 * Expected files written under the home root after sync:
 * `buildExpectedTrioProductFilePaths(VIRTUAL_HOME_DIR)`.
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
    filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', 'my-skill', 'SKILL.md'),
    content: '# My Skill\n',
  });
}

/**
 * Strips chalk's ANSI CSI escape codes (e.g. `\x1B[1m`) from a string
 * so report assertions can focus on structure rather than baking
 * chalk's styling bytes into the expected output.
 */
const stripAnsi = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

function clearCapturedOutput(output: {
  stdoutMessages: string[];
  stderrMessages: string[];
}): void {
  output.stdoutMessages.length = 0;
  output.stderrMessages.length = 0;
}

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
 * `SKILL.md` for Cursor command targets). Single source of truth for trio sync outputs;
 * use `buildExpectedTrioProductFilePaths(VIRTUAL_HOME_DIR)` (or `basicWrittenFilePaths`) where the home is virtual.
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

type SyncSourceKind = 'command' | 'rule' | 'skill';
type SyncAgentUnderTest = 'copilot' | 'cursor';

const matrixSourceNames = {
  command: ['alpha-command', 'beta-command'],
  rule: ['alpha-rule', 'beta-rule'],
  skill: ['alpha-skill', 'beta-skill'],
} as const;

function collectGeneratedHomeFilePaths(): string[] {
  return [...mockFileSystem.files.keys()]
    .filter(
      (filePath) =>
        filePath.startsWith(VIRTUAL_HOME_DIR) &&
        !filePath.startsWith(DEFAULT_CONFIG_ROOT),
    )
    .sort();
}

function arrangeCommandSources(commandNames: readonly string[]): void {
  for (const commandName of commandNames) {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', `${commandName}.md`),
      content: [
        '---',
        `name: ${commandName}`,
        `description: ${commandName} description`,
        '---',
        '',
        `${commandName} body`,
        '',
      ].join('\n'),
    });
  }
}

function arrangeRuleSources(ruleNames: readonly string[]): void {
  for (const ruleName of ruleNames) {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', `${ruleName}.md`),
      content: [
        '---',
        `description: ${ruleName} description`,
        'agents:',
        '  copilot:',
        "    applyTo: '**'",
        '  cursor:',
        "    globs: '**'",
        '---',
        '',
        `${ruleName} body`,
        '',
      ].join('\n'),
    });
  }
}

function arrangeSkillSources(skillNames: readonly string[]): void {
  for (const skillName of skillNames) {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', skillName, 'SKILL.md'),
      content: `# ${skillName}\n`,
    });
  }
}

function arrangeSyncMatrixSources(input: {
  kinds: readonly SyncSourceKind[];
  countPerKind: 1 | 2;
}): void {
  for (const kind of input.kinds) {
    const names = matrixSourceNames[kind].slice(0, input.countPerKind);
    if (kind === 'command') {
      arrangeCommandSources(names);
    } else if (kind === 'rule') {
      arrangeRuleSources(names);
    } else {
      arrangeSkillSources(names);
    }
  }
}

function buildAgentOutputPaths(input: {
  agent: SyncAgentUnderTest;
  kinds: readonly SyncSourceKind[];
  countPerKind: 1 | 2;
}): string[] {
  const outputPaths: string[] = [];

  for (const kind of input.kinds) {
    for (const name of matrixSourceNames[kind].slice(0, input.countPerKind)) {
      if (input.agent === 'copilot' && kind === 'command') {
        outputPaths.push(
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            `${name}.prompt.md`,
          ),
        );
      } else if (input.agent === 'copilot' && kind === 'rule') {
        outputPaths.push(
          path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'instructions',
            `${name}.instructions.md`,
          ),
        );
      } else if (input.agent === 'copilot' && kind === 'skill') {
        outputPaths.push(
          path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills', name, 'SKILL.md'),
        );
      } else if (input.agent === 'cursor' && kind === 'command') {
        outputPaths.push(
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills', name, 'SKILL.md'),
        );
      } else if (input.agent === 'cursor' && kind === 'rule') {
        outputPaths.push(
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules', `${name}.mdc`),
        );
      } else {
        outputPaths.push(
          path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills', name, 'SKILL.md'),
        );
      }
    }
  }

  return outputPaths.slice().sort();
}

function collectAgentGeneratedFilePaths(agent: SyncAgentUnderTest): string[] {
  const agentRoot =
    agent === 'copilot'
      ? path.join(VIRTUAL_HOME_DIR, '.copilot')
      : path.join(VIRTUAL_HOME_DIR, '.cursor');

  return collectGeneratedHomeFilePaths()
    .filter((filePath) => filePath.startsWith(agentRoot))
    .slice()
    .sort();
}

/**
 * Expected home files after `arrangeBasicSources()` + `dry-ai sync` under the
 * virtual home directory. Alias for readable call sites (`basicWrittenFilePaths`).
 *
 * @see buildExpectedTrioProductFilePaths
 */
const basicWrittenFilePaths =
  buildExpectedTrioProductFilePaths(VIRTUAL_HOME_DIR);

describe('dry-ai sync registry contracts', () => {
  it('keeps e2e output-tree coverage exhaustive for every SyncAgent', () => {
    expect(e2eOutputTreeTestCoverageByAgent).toBeDefined();
  });
});

const feature = await loadFeature('./sync.feature');

describeFeature(feature, (f) => {
  // Each Gherkin step runs as its own Vitest test. With `restoreMocks: true`,
  // implementations on `vi.fn()` mocks are cleared after every step, so we
  // must re-apply glob + OS wiring before each step while preserving the
  // mock filesystem state built in earlier steps of the same scenario.
  beforeEach(() => {
    installSyncTestGlobMock();
    configureMockOs({
      mockedOs: mockedOs,
      homeDir: VIRTUAL_HOME_DIR,
      tmpDir: '/virtual/tmp',
    });
  });

  f.Rule('Valid sources produce expected agent artifacts', (r) => {
    r.RuleScenarioOutline(
      'Sync basic sources for each supported agent',
      ({ Given, When, Then, And }, examples) => {
        function outputPathsForExampleAgent(agent: string): {
          commandPath: string;
          rulePath: string;
          skillPath: string;
        } {
          if (agent === 'copilot') {
            return {
              commandPath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'my-cmd.prompt.md',
              ),
              rulePath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'instructions',
                'my-rule.instructions.md',
              ),
              skillPath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'skills',
                'my-skill',
                'SKILL.md',
              ),
            };
          }

          return {
            commandPath: path.join(
              VIRTUAL_HOME_DIR,
              '.cursor',
              'skills',
              'my-cmd',
              'SKILL.md',
            ),
            rulePath: path.join(
              VIRTUAL_HOME_DIR,
              '.cursor',
              'rules',
              'my-rule.mdc',
            ),
            skillPath: path.join(
              VIRTUAL_HOME_DIR,
              '.cursor',
              'skills',
              'my-skill',
              'SKILL.md',
            ),
          };
        }

        let env: ReturnType<typeof createTestEnv>;

        Given(
          'the config root contains one command, one rule, and one skill',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
          },
        );

        When('I run "dry-ai sync"', async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({ argv: ['sync'], ...env.cliOptions });
        });

        Then('<agent> command output is written', () => {
          const { commandPath } = outputPathsForExampleAgent(
            examples.agent as string,
          );
          expect(env.stderrMessages).toEqual([]);
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: commandPath }),
          ).toContain('Command body');
        });

        And('<agent> rule output is written', () => {
          const { rulePath } = outputPathsForExampleAgent(
            examples.agent as string,
          );
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: rulePath }),
          ).toContain('Rule body');
        });

        And('<agent> skill output is written', () => {
          const { skillPath } = outputPathsForExampleAgent(
            examples.agent as string,
          );
          expect(
            readMockTextFile({ handle: mockFileSystem, filePath: skillPath }),
          ).toBe('# My Skill\n');
        });
      },
    );

    r.RuleScenarioOutline(
      'Sync two files per kind for each supported agent',
      ({ Given, When, Then }, examples) => {
        const twoPerKindAgentSchema = z.object({
          agent: z.enum(['copilot', 'cursor']),
        });
        const row = twoPerKindAgentSchema.parse(examples);

        let env: ReturnType<typeof createTestEnv>;

        Given(
          'the config root contains two commands, two rules, and two skills',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeSyncMatrixSources({
              kinds: ['command', 'rule', 'skill'],
              countPerKind: 2,
            });
          },
        );

        When('I run "dry-ai sync"', async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({ argv: ['sync'], ...env.cliOptions });
        });

        Then('<agent> has generated outputs for every source', () => {
          const { agent } = row;
          expect(env.stderrMessages).toEqual([]);
          expect(collectAgentGeneratedFilePaths(agent)).toEqual(
            buildAgentOutputPaths({
              agent,
              kinds: ['command', 'rule', 'skill'],
              countPerKind: 2,
            }),
          );
        });
      },
    );

    r.RuleScenarioOutline(
      'Sync two source kinds without the third kind',
      ({ Given, When, Then, And }, examples) => {
        const examplesSchema = z
          .object({
            agent: z.enum(['copilot', 'cursor']),
            includedKinds: z
              .string()
              .transform((s) =>
                s
                  .split(',')
                  .map((part) => part.trim())
                  .filter((part) => part.length > 0),
              )
              .pipe(z.array(z.enum(['command', 'rule', 'skill']))),
          })
          .transform(({ agent, includedKinds }) => ({
            agent,
            kinds: includedKinds,
          }));

        const outlineRow = examplesSchema.parse(examples);

        let env: ReturnType<typeof createTestEnv>;

        Given(
          'the config root contains sources for <includedKinds> and no sources for the other kind',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeSyncMatrixSources({
              kinds: outlineRow.kinds,
              countPerKind: 1,
            });
          },
        );

        When('I run "dry-ai sync"', async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({ argv: ['sync'], ...env.cliOptions });
        });

        Then('<agent> has generated outputs for <includedKinds>', () => {
          const { agent, kinds } = outlineRow;
          expect(env.stderrMessages).toEqual([]);
          expect(collectAgentGeneratedFilePaths(agent)).toEqual(
            buildAgentOutputPaths({
              agent,
              kinds,
              countPerKind: 1,
            }),
          );
        });

        And('<agent> has no generated outputs for the other kind', () => {
          const { agent, kinds } = outlineRow;
          const included = new Set(kinds);
          const excluded = (['command', 'rule', 'skill'] as const).filter(
            (k) => !included.has(k),
          );
          const actual = new Set(collectAgentGeneratedFilePaths(agent));
          for (const kind of excluded) {
            for (const p of buildAgentOutputPaths({
              agent,
              kinds: [kind],
              countPerKind: 1,
            })) {
              expect(actual.has(p)).toBe(false);
            }
          }
        });
      },
    );

    r.RuleScenarioOutline(
      'Sync one source kind',
      ({ Given, When, Then, And }, examples) => {
        const oneKindOutlineSchema = z
          .object({
            agent: z.enum(['copilot', 'cursor']),
            kind: z.enum(['command', 'rule', 'skill']),
          })
          .transform(({ agent, kind }) => ({
            agent,
            kinds: [kind] as SyncSourceKind[],
          }));

        const row = oneKindOutlineSchema.parse(examples);

        let env: ReturnType<typeof createTestEnv>;

        Given('the config root contains only <kind> sources', () => {
          resetDryAiSyncTestFixtures();
          arrangeSyncMatrixSources({
            kinds: row.kinds,
            countPerKind: 1,
          });
        });

        When('I run "dry-ai sync"', async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({ argv: ['sync'], ...env.cliOptions });
        });

        Then('<agent> has generated outputs for <kind>', () => {
          const { agent, kinds } = row;
          expect(env.stderrMessages).toEqual([]);
          expect(collectAgentGeneratedFilePaths(agent)).toEqual(
            buildAgentOutputPaths({
              agent,
              kinds,
              countPerKind: 1,
            }),
          );
        });

        And(
          '<agent> has no generated outputs for the other source kinds',
          () => {
            const { agent, kinds } = row;
            const included = new Set(kinds);
            const excluded = (['command', 'rule', 'skill'] as const).filter(
              (k) => !included.has(k),
            );
            const actual = new Set(collectAgentGeneratedFilePaths(agent));
            for (const kind of excluded) {
              for (const p of buildAgentOutputPaths({
                agent,
                kinds: [kind],
                countPerKind: 1,
              })) {
                expect(actual.has(p)).toBe(false);
              }
            }
          },
        );
      },
    );

    r.RuleScenario(
      'Write the basic trio to every supported agent target',
      ({ Given, When, Then }) => {
        let env: ReturnType<typeof createTestEnv>;

        Given(
          'the config root contains one command, one rule, and one skill',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
          },
        );

        When('I run "dry-ai sync"', async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({ argv: ['sync'], ...env.cliOptions });
        });

        Then(
          'every supported agent target contains its generated outputs',
          () => {
            expect(env.stderrMessages).toEqual([]);
            for (const writtenFilePath of basicWrittenFilePaths) {
              expect(mockFileSystem.files.has(writtenFilePath)).toBe(true);
            }
          },
        );
      },
    );

    r.RuleScenario(
      'Write one output per rule file',
      ({ Given, When, Then, And }) => {
        let env: ReturnType<typeof createTestEnv>;

        Given('the config root contains two rule files', () => {
          resetDryAiSyncTestFixtures();
          arrangeRuleSources(['alpha-rule', 'beta-rule']);
        });

        When('I run "dry-ai sync"', async () => {
          env = createTestEnv({ mockFileSystem });
          await runCLI({ argv: ['sync'], ...env.cliOptions });
        });

        Then('each rule file has a Copilot rule output', () => {
          expect(env.stderrMessages).toEqual([]);
          for (const filePath of [
            path.join(
              VIRTUAL_HOME_DIR,
              '.copilot',
              'instructions',
              'alpha-rule.instructions.md',
            ),
            path.join(
              VIRTUAL_HOME_DIR,
              '.copilot',
              'instructions',
              'beta-rule.instructions.md',
            ),
          ]) {
            expect(mockFileSystem.files.has(filePath)).toBe(true);
          }
        });

        And('each rule file has a Cursor rule output', () => {
          for (const filePath of [
            path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules', 'alpha-rule.mdc'),
            path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules', 'beta-rule.mdc'),
          ]) {
            expect(mockFileSystem.files.has(filePath)).toBe(true);
          }
        });
      },
    );
  });
});

describe('dry-ai sync', () => {
  beforeEach(() => {
    resetDryAiSyncTestFixtures();
  });

  function arrangeMixedConfigSources(): void {
    for (const commandName of ['alpha-cmd', 'beta-cmd'] as const) {
      storeMockTextFile({
        handle: mockFileSystem,
        filePath: path.join(
          DEFAULT_CONFIG_ROOT,
          'commands',
          `${commandName}.md`,
        ),
        content: [
          '---',
          `name: ${commandName}`,
          `description: ${commandName} description`,
          '---',
          '',
          `${commandName} body`,
          '',
        ].join('\n'),
      });
    }

    for (const ruleName of ['alpha-rule', 'beta-rule'] as const) {
      storeMockTextFile({
        handle: mockFileSystem,
        filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', `${ruleName}.md`),
        content: [
          '---',
          `${ruleName === 'alpha-rule' ? 'description: Alpha rule' : 'description: Beta rule'}`,
          'agents:',
          '  copilot:',
          "    applyTo: '**'",
          '  cursor:',
          `    globs: '${ruleName === 'alpha-rule' ? 'src/**/*.ts' : 'test/**/*.ts'}'`,
          '---',
          '',
          `${ruleName} body`,
          '',
        ].join('\n'),
      });
    }

    for (const skillName of ['alpha-skill', 'beta-skill'] as const) {
      storeMockTextFile({
        handle: mockFileSystem,
        filePath: path.join(
          DEFAULT_CONFIG_ROOT,
          'skills',
          skillName,
          'SKILL.md',
        ),
        content: `# ${skillName}\n`,
      });
    }
  }

  function readSyncManifest(): z.infer<typeof mockSyncManifestSchema> {
    return mockSyncManifestSchema.parse(
      JSON.parse(
        readMockTextFile({
          handle: mockFileSystem,
          filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
        }),
      ),
    );
  }

  function getBasicCommandOutputPath(agent: SyncAgentUnderTest): string {
    return agent === 'copilot'
      ? path.join(VIRTUAL_HOME_DIR, '.copilot', 'prompts', 'my-cmd.prompt.md')
      : path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills', 'my-cmd', 'SKILL.md');
  }

  function arrangeCursorSkillNameConflict(): void {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'shared-command.md'),
      content: [
        '---',
        'name: shared',
        'description: Command that collides with a Cursor skill',
        '---',
        '',
        'Command body',
        '',
      ].join('\n'),
    });
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', 'shared', 'SKILL.md'),
      content: '# Shared skill\n',
    });
  }

  describe('Rule: Valid sources produce expected agent artifacts', () => {
    describe.skip('Scenario Outline: Sync basic sources for each supported agent', () => {
      describe('Given the config root contains one command, one rule, and one skill', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <agent> command output is written', () => {
            describe('And <agent> rule output is written', () => {
              describe('And <agent> skill output is written', () => {
                it.each([
                  {
                    agent: 'copilot',
                    commandPath: path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'prompts',
                      'my-cmd.prompt.md',
                    ),
                    rulePath: path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'instructions',
                      'my-rule.instructions.md',
                    ),
                    skillPath: path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'skills',
                      'my-skill',
                      'SKILL.md',
                    ),
                  },
                  {
                    agent: 'cursor',
                    commandPath: path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'my-cmd',
                      'SKILL.md',
                    ),
                    rulePath: path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'rules',
                      'my-rule.mdc',
                    ),
                    skillPath: path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'my-skill',
                      'SKILL.md',
                    ),
                  },
                ] as const)(
                  'Examples: $agent',
                  async ({ commandPath, rulePath, skillPath }) => {
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
                      readMockTextFile({
                        handle: mockFileSystem,
                        filePath: commandPath,
                      }),
                    ).toContain('Command body');
                    expect(
                      readMockTextFile({
                        handle: mockFileSystem,
                        filePath: rulePath,
                      }),
                    ).toContain('Rule body');
                    expect(
                      readMockTextFile({
                        handle: mockFileSystem,
                        filePath: skillPath,
                      }),
                    ).toBe('# My Skill\n');
                  },
                );
              });
            });
          });
        });
      });
    });

    describe.skip('Scenario Outline: Sync two files per kind for each supported agent', () => {
      describe('Given the config root contains two commands, two rules, and two skills', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <agent> has generated outputs for every source', () => {
            it.each([
              { agent: 'copilot', label: 'Copilot' },
              { agent: 'cursor', label: 'Cursor' },
            ] as const)('Examples: $label', async ({ agent }) => {
              arrangeSyncMatrixSources({
                kinds: ['command', 'rule', 'skill'],
                countPerKind: 2,
              });
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(collectAgentGeneratedFilePaths(agent)).toEqual(
                buildAgentOutputPaths({
                  agent,
                  kinds: ['command', 'rule', 'skill'],
                  countPerKind: 2,
                }),
              );
            });
          });
        });
      });
    });

    describe.skip('Scenario Outline: Sync two source kinds without the third kind', () => {
      describe('Given the config root contains sources for <includedKinds> and no sources for the other kind', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <agent> has generated outputs for <includedKinds>', () => {
            describe('And <agent> has no generated outputs for the other kind', () => {
              it.each([
                {
                  agent: 'copilot',
                  label: 'Copilot commands and rules',
                  kinds: ['command', 'rule'],
                },
                {
                  agent: 'copilot',
                  label: 'Copilot commands and skills',
                  kinds: ['command', 'skill'],
                },
                {
                  agent: 'copilot',
                  label: 'Copilot rules and skills',
                  kinds: ['rule', 'skill'],
                },
                {
                  agent: 'cursor',
                  label: 'Cursor commands and rules',
                  kinds: ['command', 'rule'],
                },
                {
                  agent: 'cursor',
                  label: 'Cursor commands and skills',
                  kinds: ['command', 'skill'],
                },
                {
                  agent: 'cursor',
                  label: 'Cursor rules and skills',
                  kinds: ['rule', 'skill'],
                },
              ] as const)('Examples: $label', async ({ agent, kinds }) => {
                arrangeSyncMatrixSources({ kinds, countPerKind: 1 });
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(collectAgentGeneratedFilePaths(agent)).toEqual(
                  buildAgentOutputPaths({
                    agent,
                    kinds,
                    countPerKind: 1,
                  }),
                );
              });
            });
          });
        });
      });
    });

    describe.skip('Scenario Outline: Sync one source kind', () => {
      describe('Given the config root contains only <kind> sources', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <agent> has generated outputs for <kind>', () => {
            describe('And <agent> has no generated outputs for the other source kinds', () => {
              it.each([
                {
                  agent: 'copilot',
                  label: 'Copilot commands only',
                  kinds: ['command'],
                },
                {
                  agent: 'copilot',
                  label: 'Copilot rules only',
                  kinds: ['rule'],
                },
                {
                  agent: 'copilot',
                  label: 'Copilot skills only',
                  kinds: ['skill'],
                },
                {
                  agent: 'cursor',
                  label: 'Cursor commands only',
                  kinds: ['command'],
                },
                {
                  agent: 'cursor',
                  label: 'Cursor rules only',
                  kinds: ['rule'],
                },
                {
                  agent: 'cursor',
                  label: 'Cursor skills only',
                  kinds: ['skill'],
                },
              ] as const)('Examples: $label', async ({ agent, kinds }) => {
                arrangeSyncMatrixSources({ kinds, countPerKind: 1 });
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(collectAgentGeneratedFilePaths(agent)).toEqual(
                  buildAgentOutputPaths({
                    agent,
                    kinds,
                    countPerKind: 1,
                  }),
                );
              });
            });
          });
        });
      });
    });

    describe.skip('Scenario: Write the basic trio to every supported agent target', () => {
      describe('Given the config root contains one command, one rule, and one skill', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then every supported agent target contains its generated outputs', () => {
            it('passes', async () => {
              arrangeBasicSources();

              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              for (const writtenFilePath of basicWrittenFilePaths) {
                expect(mockFileSystem.files.has(writtenFilePath)).toBe(true);
              }
            });
          });
        });
      });
    });

    describe.skip('Scenario: Write one output per rule file', () => {
      describe('Given the config root contains two rule files', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each rule file has a Copilot rule output', () => {
            describe('And each rule file has a Cursor rule output', () => {
              it('passes', async () => {
                arrangeRuleSources(['alpha-rule', 'beta-rule']);

                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                for (const filePath of [
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'alpha-rule.instructions.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'beta-rule.instructions.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'alpha-rule.mdc',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'beta-rule.mdc',
                  ),
                ]) {
                  expect(mockFileSystem.files.has(filePath)).toBe(true);
                }
              });
            });
          });
        });
      });
    });

    describe('Scenario: Copy one output tree per skill directory', () => {
      describe('Given the config root contains two skill directories', () => {
        describe('And each skill directory contains supporting files', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then each skill directory is copied to every supported agent target', () => {
              describe('And supporting files keep their source content', () => {
                it('passes', async () => {
                  for (const [skillName, body, extraBody] of [
                    [
                      'alpha-skill',
                      '# Alpha skill\n',
                      'Alpha supporting file\n',
                    ] as const,
                    [
                      'beta-skill',
                      '# Beta skill\n',
                      'Beta supporting file\n',
                    ] as const,
                  ]) {
                    const skillDir = path.join(
                      DEFAULT_CONFIG_ROOT,
                      'skills',
                      skillName,
                    );
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

                  for (const agentRoot of [
                    path.join(VIRTUAL_HOME_DIR, '.copilot', 'skills'),
                    path.join(VIRTUAL_HOME_DIR, '.cursor', 'skills'),
                  ]) {
                    for (const skillName of [
                      'alpha-skill',
                      'beta-skill',
                    ] as const) {
                      for (const fileName of [
                        'SKILL.md',
                        'context.md',
                      ] as const) {
                        expect(
                          mockFileSystem.files.has(
                            path.join(agentRoot, skillName, fileName),
                          ),
                        ).toBe(true);
                      }
                    }
                  }

                  expect(
                    readMockTextFile({
                      handle: mockFileSystem,
                      filePath: path.join(
                        VIRTUAL_HOME_DIR,
                        '.copilot',
                        'skills',
                        'alpha-skill',
                        'context.md',
                      ),
                    }),
                  ).toBe('Alpha supporting file\n');
                  expect(
                    readMockTextFile({
                      handle: mockFileSystem,
                      filePath: path.join(
                        VIRTUAL_HOME_DIR,
                        '.cursor',
                        'skills',
                        'beta-skill',
                        'context.md',
                      ),
                    }),
                  ).toBe('Beta supporting file\n');
                });
              });
            });
          });
        });
      });
    });

    describe('Scenario: Write generated files for a mixed config', () => {
      describe('Given the config root contains multiple commands, rules, and skills', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the generated home files match the expected mixed output set', () => {
            it('passes', async () => {
              arrangeMixedConfigSources();
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(collectGeneratedHomeFilePaths()).toEqual(
                [
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'alpha-cmd.prompt.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'beta-cmd.prompt.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'alpha-rule.instructions.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'beta-rule.instructions.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'alpha-skill',
                    'SKILL.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'beta-skill',
                    'SKILL.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'alpha-cmd',
                    'SKILL.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'beta-cmd',
                    'SKILL.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'alpha-rule.mdc',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'beta-rule.mdc',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'alpha-skill',
                    'SKILL.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'beta-skill',
                    'SKILL.md',
                  ),
                ].sort(),
              );
            });
          });
        });
      });
    });

    describe('Scenario: Sync when agent home trees do not exist', () => {
      describe('Given the config root contains one command, one rule, and one skill', () => {
        describe('And no agent home output trees exist yet', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then the command output is written for every supported agent', () => {
              describe('And the rule output is written for every supported agent', () => {
                describe('And the skill output is written for every supported agent', () => {
                  it('passes', async () => {
                    arrangeBasicSources();

                    const { cliOptions, stderrMessages } = createTestEnv({
                      mockFileSystem,
                    });

                    await runCLI({
                      argv: ['sync'],
                      ...cliOptions,
                    });

                    expect(stderrMessages).toEqual([]);
                    for (const writtenFilePath of basicWrittenFilePaths) {
                      expect(mockFileSystem.files.has(writtenFilePath)).toBe(
                        true,
                      );
                    }
                  });
                });
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Place each supported agent files under its expected layout', () => {
      describe('Given the config root contains one command, one rule, and one skill', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <agent> command, rule, and skill outputs are placed under the expected layout', () => {
            it.each([
              {
                agent: 'Copilot',
                expectedPaths: [
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'my-rule.instructions.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'my-skill',
                    'SKILL.md',
                  ),
                ],
              },
              {
                agent: 'Cursor',
                expectedPaths: [
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'my-cmd',
                    'SKILL.md',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'my-rule.mdc',
                  ),
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'my-skill',
                    'SKILL.md',
                  ),
                ],
              },
            ] as const)('Examples: $agent', async ({ expectedPaths }) => {
              arrangeBasicSources();
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              for (const expectedPath of expectedPaths) {
                expect(mockFileSystem.files.has(expectedPath)).toBe(true);
              }
            });
          });
        });
      });
    });

    describe('Scenario: Write agent-specific output from valid per-agent frontmatter', () => {
      describe('Given a command and rule define valid per-agent frontmatter', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each generated output reflects only its matching agent metadata', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'agent-command.md',
                ),
                content: [
                  '---',
                  'name: agent-command',
                  'description: Agent command',
                  'agents:',
                  '  copilot: {}',
                  '  cursor:',
                  '    disable-model-invocation: true',
                  '---',
                  '',
                  'Command body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'agent-rule.md',
                ),
                content: [
                  '---',
                  'description: Agent rule',
                  'agents:',
                  '  copilot:',
                  "    applyTo: '**/*.ts'",
                  '  cursor:',
                  "    globs: 'src/**/*.ts'",
                  '---',
                  '',
                  'Rule body',
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
              const copilotCommand = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'agent-command.prompt.md',
                ),
              });
              const cursorCommand = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'agent-command',
                  'SKILL.md',
                ),
              });
              const copilotRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'agent-rule.instructions.md',
                ),
              });
              const cursorRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'agent-rule.mdc',
                ),
              });

              expect(copilotCommand).not.toContain('disable-model-invocation');
              expect(cursorCommand).toContain('disable-model-invocation: true');
              expect(copilotRule).toContain("applyTo: '**/*.ts'");
              expect(copilotRule).not.toContain('globs:');
              expect(cursorRule).toContain('globs: src/**/*.ts');
              expect(cursorRule).not.toContain('alwaysApply:');
              expect(cursorRule).not.toContain('applyTo:');
            });
          });
        });
      });
    });

    describe('Scenario: Write Copilot command output with normalized markdown structure', () => {
      describe('Given a command source has extra body whitespace', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the Copilot command prompt has re-serialized frontmatter and a trimmed body', () => {
            it('passes', async () => {
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
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'fmt-cmd.md',
                ),
                content: rawSource,
              });

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
          });
        });
      });
    });

    describe('Scenario: Write Copilot rule output with normalized markdown structure', () => {
      describe('Given a rule source has extra body whitespace and agent metadata', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the Copilot instructions file has re-serialized frontmatter and a trimmed body', () => {
            it('passes', async () => {
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
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'fmt-rule.md',
                ),
                content: rawSource,
              });

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
          });
        });
      });
    });

    describe('Scenario: Omit unresolved optional frontmatter keys', () => {
      describe('Given command and rule sources omit optional agent fields', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then generated YAML does not include null, undefined, or placeholder optional keys', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'optional-command.md',
                ),
                content: [
                  '---',
                  'name: optional-command',
                  'description: Optional command',
                  'agents:',
                  '  cursor: {}',
                  '---',
                  '',
                  'Command body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'optional-rule.md',
                ),
                content: [
                  '---',
                  'description: Optional rule',
                  'agents:',
                  '  copilot:',
                  "    applyTo: '**'",
                  '  cursor:',
                  '    alwaysApply: true',
                  '---',
                  '',
                  'Rule body',
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
              const cursorCommand = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'optional-command',
                  'SKILL.md',
                ),
              });
              const cursorRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'optional-rule.mdc',
                ),
              });

              for (const output of [cursorCommand, cursorRule]) {
                expect(output).not.toMatch(/\bnull\b/);
                expect(output).not.toMatch(/\bundefined\b/);
              }
              expect(cursorCommand).not.toContain('disable-model-invocation:');
              expect(cursorRule).not.toContain('globs:');
              expect(cursorRule).toContain('alwaysApply: true');
            });
          });
        });
      });
    });

    describe('Scenario: Keep body whitespace normalization consistent across output types', () => {
      describe('Given command and rule sources contain similarly spaced bodies', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then generated command and rule outputs preserve the normalized body text', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'body-command.md',
                ),
                content: [
                  '---',
                  'name: body-command',
                  'description: Body command',
                  '---',
                  '',
                  '',
                  '  First command line.  ',
                  '  Second command line.  ',
                  '',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'body-rule.md',
                ),
                content: [
                  '---',
                  'description: Body rule',
                  'agents:',
                  '  copilot:',
                  "    applyTo: '**'",
                  '  cursor:',
                  "    globs: 'src/**/*.ts'",
                  '---',
                  '',
                  '',
                  '  First rule line.  ',
                  '  Second rule line.  ',
                  '',
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
              const expectedCommandBody =
                'First command line.  \n  Second command line.';
              const expectedRuleBody =
                'First rule line.  \n  Second rule line.';
              for (const outputPath of [
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'body-command.prompt.md',
                ),
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'body-command',
                  'SKILL.md',
                ),
              ]) {
                expect(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: outputPath,
                  }),
                ).toContain(expectedCommandBody);
              }
              for (const outputPath of [
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'body-rule.instructions.md',
                ),
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'body-rule.mdc',
                ),
              ]) {
                expect(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: outputPath,
                  }),
                ).toContain(expectedRuleBody);
              }
            });
          });
        });
      });
    });

    describe('Scenario: Write rule outputs with only top-level metadata when agents are omitted', () => {
      describe('Given a rule source omits the agents block', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then Copilot and Cursor rule files contain only description metadata', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'copilot-default-rule.md',
                ),
                content: [
                  '---',
                  'description: Copilot default rule',
                  '---',
                  '',
                  'Rule body',
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
              const copilotRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'copilot-default-rule.instructions.md',
                ),
              });
              expect(copilotRule).toContain(
                'description: Copilot default rule',
              );
              expect(copilotRule).not.toContain('applyTo:');
              const cursorRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'copilot-default-rule.mdc',
                ),
              });
              expect(cursorRule).toContain('description: Copilot default rule');
              expect(cursorRule).not.toContain('alwaysApply:');
              expect(cursorRule).not.toContain('globs:');
            });
          });
        });
      });
    });

    describe('Scenario: Write Cursor rule fields for each supported apply mode', () => {
      describe('Given rule sources use each supported Cursor apply mode', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each Cursor rule output contains only the expected apply fields', () => {
            it('passes', async () => {
              const fixtures = [
                {
                  fileStem: 'cursor-glob-rule',
                  cursorLines: ["    globs: 'src/**/*.ts'"],
                  expected: ['globs: src/**/*.ts'],
                  unexpected: ['alwaysApply:'],
                },
                {
                  fileStem: 'cursor-double-star-rule',
                  cursorLines: ["    globs: '**'"],
                  expected: ["globs: '**'"],
                  unexpected: ['alwaysApply:'],
                },
                {
                  fileStem: 'cursor-explicit-always-rule',
                  cursorLines: ['    alwaysApply: true'],
                  expected: ['alwaysApply: true'],
                  unexpected: ['globs:'],
                },
              ] as const;

              for (const fixture of fixtures) {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'rules',
                    `${fixture.fileStem}.md`,
                  ),
                  content: [
                    '---',
                    `description: ${fixture.fileStem}`,
                    'agents:',
                    '  copilot:',
                    "    applyTo: '**'",
                    '  cursor:',
                    ...fixture.cursorLines,
                    '---',
                    '',
                    'Rule body',
                    '',
                  ].join('\n'),
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
              for (const fixture of fixtures) {
                const cursorRule = readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    `${fixture.fileStem}.mdc`,
                  ),
                });
                for (const expected of fixture.expected) {
                  expect(cursorRule).toContain(expected);
                }
                for (const unexpected of fixture.unexpected) {
                  expect(cursorRule).not.toContain(unexpected);
                }
              }
            });
          });
        });
      });
    });

    describe('Scenario: Keep agent-specific rule fields and metadata scoped to each output', () => {
      describe('Given a rule source defines different Copilot and Cursor metadata', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each agent rule file contains only its own frontmatter keys', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'scoped-fields-rule.md',
                ),
                content: [
                  '---',
                  'description: Scoped fields rule',
                  'agents:',
                  '  copilot:',
                  "    applyTo: '**/*.ts'",
                  '  cursor:',
                  "    globs: 'src/**/*.ts'",
                  '---',
                  '',
                  'Rule body',
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
              const copilotRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'scoped-fields-rule.instructions.md',
                ),
              });
              const cursorRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'scoped-fields-rule.mdc',
                ),
              });
              expect(copilotRule).toContain("applyTo: '**/*.ts'");
              expect(copilotRule).not.toContain('globs:');
              expect(copilotRule).not.toContain('alwaysApply:');
              expect(cursorRule).toContain('globs: src/**/*.ts');
              expect(cursorRule).not.toContain('alwaysApply:');
              expect(cursorRule).not.toContain('applyTo:');
            });
          });
        });
      });
    });

    describe('Scenario: Mirror the complete skill source tree into each agent target', () => {
      describe('Given a skill source contains root and nested files', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then every supported agent skill target contains the same files and contents', () => {
            it('passes', async () => {
              const skillName = 'tree-skill';
              const skillRoot = path.join(
                DEFAULT_CONFIG_ROOT,
                'skills',
                skillName,
              );
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
          });
        });
      });
    });

    describe('Scenario: Remove deleted source files from copied skill targets on the next sync', () => {
      describe('Given a synced skill source file is deleted after an initial sync', () => {
        describe('When I run "dry-ai sync" again', () => {
          describe('Then every supported agent skill copy removes the deleted file and keeps SKILL.md', () => {
            it('passes', async () => {
              const skillName = 'prune-skill';
              const skillRoot = path.join(
                DEFAULT_CONFIG_ROOT,
                'skills',
                skillName,
              );
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

              expect(
                deleteMockTextFile({
                  handle: mockFileSystem,
                  filePath: normalizeMockPath(orphanSource),
                }),
              ).toBe(true);

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
        });
      });
    });
  });

  describe('Rule: Sync manifest tracks managed artifact state', () => {
    describe('Scenario: Write mixed config manifest rows without dropping or merging kinds', () => {
      describe('Given the config root contains multiple commands, rules, and skills', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the sync manifest contains sorted rows for every agent and source kind', () => {
            it('passes', async () => {
              arrangeMixedConfigSources();
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              const { outputs } = readSyncManifest();
              expect(outputs).toHaveLength(12);
              expect(outputs).toEqual(
                outputs.slice().sort(compareManifestEntryTuples),
              );

              expect(
                outputs.filter((entry) => entry.kind === 'command'),
              ).toHaveLength(4);
              expect(
                outputs.filter((entry) => entry.kind === 'rule'),
              ).toHaveLength(4);
              expect(
                outputs.filter((entry) => entry.kind === 'skill'),
              ).toHaveLength(4);
            });
          });
        });
      });
    });

    describe('Scenario: Create sync-manifest.json on the first run', () => {
      describe('Given the config root contains one command, one rule, and one skill', () => {
        describe('And sync-manifest.json does not exist yet', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then sync-manifest.json is created with the expected rows', () => {
              it('passes', async () => {
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
            });
          });
        });
      });
    });

    describe('Scenario: Add manifest rows for a new command on the next sync', () => {
      describe('Given sync-manifest.json already tracks the basic sources', () => {
        describe('And a new command source is added', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then sync-manifest.json includes the original rows and the new command rows', () => {
              it('passes', async () => {
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
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'extra-cmd.md',
                  ),
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
                // `extra-cmd.md` -> stem `extra-cmd`; frontmatter `name` matches the stem in this fixture.

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });
                expect(stderrMessages).toEqual([]);

                const afterSecond = readMockTextFile({
                  handle: mockFileSystem,
                  filePath: manifestPath,
                });
                expect(JSON.parse(afterFirst)).not.toEqual(
                  JSON.parse(afterSecond),
                );

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
            });
          });
        });
      });
    });

    describe('Scenario: List manifest entries in deterministic tuple order', () => {
      describe('Given sources are discovered in a non-sorted order', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then sync-manifest.json entries are sorted by manifest tuple', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'z-command.md',
                ),
                content: [
                  '---',
                  'name: z-command',
                  'description: Z command',
                  '---',
                  '',
                  'Z body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'a-command.md',
                ),
                content: [
                  '---',
                  'name: a-command',
                  'description: A command',
                  '---',
                  '',
                  'A body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'z-skill',
                  'SKILL.md',
                ),
                content: '# Z skill\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'a-skill',
                  'SKILL.md',
                ),
                content: '# A skill\n',
              });
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              const manifest = mockSyncManifestSchema.parse(
                JSON.parse(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
                  }),
                ),
              );
              expect(manifest.outputs).toEqual(
                manifest.outputs.slice().sort(compareManifestEntryTuples),
              );
            });
          });
        });
      });
    });

    describe('Scenario: Replace manifest rows for updated outputs without duplicating paths', () => {
      describe('Given sync-manifest.json already tracks the basic sources', () => {
        describe('And a generated output changes on disk', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then sync-manifest.json still has one row per output path', () => {
              it('passes', async () => {
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

                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                  content: '# locally changed\n',
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                const manifest = mockSyncManifestSchema.parse(
                  JSON.parse(
                    readMockTextFile({
                      handle: mockFileSystem,
                      filePath: manifestPath,
                    }),
                  ),
                );
                const outputPaths = manifest.outputs.map(
                  (entry) => entry.outputPath,
                );
                expect(manifest.outputs).toHaveLength(6);
                expect(new Set(outputPaths).size).toBe(outputPaths.length);
                assertMockSyncManifestMatchesTrio(
                  mockFileSystem,
                  DEFAULT_CONFIG_ROOT,
                  VIRTUAL_HOME_DIR,
                );
              });
            });
          });
        });
      });
    });

    describe('Scenario: Preserve manifest rows for unchanged outputs when another source changes', () => {
      describe('Given sync-manifest.json already tracks the basic sources', () => {
        describe('And a different command source is added', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then the previous manifest rows remain present', () => {
              it('passes', async () => {
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
                const firstManifest = mockSyncManifestSchema.parse(
                  JSON.parse(
                    readMockTextFile({
                      handle: mockFileSystem,
                      filePath: manifestPath,
                    }),
                  ),
                );
                const originalTrioRows = firstManifest.outputs;

                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'new-command.md',
                  ),
                  content: [
                    '---',
                    'name: new-command',
                    'description: New command',
                    '---',
                    '',
                    'New command body',
                    '',
                  ].join('\n'),
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                const secondManifest = mockSyncManifestSchema.parse(
                  JSON.parse(
                    readMockTextFile({
                      handle: mockFileSystem,
                      filePath: manifestPath,
                    }),
                  ),
                );
                for (const originalRow of originalTrioRows) {
                  expect(secondManifest.outputs).toContainEqual(originalRow);
                }
                expect(secondManifest.outputs).toHaveLength(8);
              });
            });
          });
        });
      });
    });
  });

  describe('Rule: Sync reports use registry labels in deterministic order', () => {
    describe('Scenario: Render the sync report with registry labels in deterministic order', () => {
      describe('Given the config root contains one command, one rule, and one skill', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report groups installed items under Copilot and Cursor in registry order', () => {
            it('passes', async () => {
              arrangeBasicSources();

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);

              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatchInlineSnapshot(`
            "Applied changes:

            - Copilot
              * commands
                - my-cmd (installed)
              * rules
                - my-rule (installed)
              * skills
                - my-skill (installed)

            - Cursor
              * commands
                - my-cmd (installed)
              * rules
                - my-rule (installed)
              * skills
                - my-skill (installed)

            Skipped conflicts: None
            "
          `);
            });
          });
        });
      });
    });
  });

  describe('Rule: Source discovery is constrained by source kind', () => {
    describe('Scenario Outline: Ignore non-markdown files under command and rule source roots', () => {
      const markdownDiscoveryScenarios = [
        {
          sourceRootName: 'commands',
          validPath: path.join(
            DEFAULT_CONFIG_ROOT,
            'commands',
            'valid-command.md',
          ),
          ignoredPath: path.join(
            DEFAULT_CONFIG_ROOT,
            'commands',
            'ignored-command.txt',
          ),
          validContent: [
            '---',
            'name: valid-command',
            'description: Valid command',
            '---',
            '',
            'Valid command body',
            '',
          ].join('\n'),
          ignoredContent: [
            '---',
            'name: ignored-command',
            'description: Ignored command',
            '---',
            '',
            'Ignored command body',
            '',
          ].join('\n'),
          expectedManifestName: 'valid-command',
          ignoredOutputPath: path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'ignored-command.prompt.md',
          ),
        },
        {
          sourceRootName: 'rules',
          validPath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'valid-rule.md'),
          ignoredPath: path.join(
            DEFAULT_CONFIG_ROOT,
            'rules',
            'ignored-rule.txt',
          ),
          validContent: [
            '---',
            'description: Valid rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Valid rule body',
            '',
          ].join('\n'),
          ignoredContent: [
            '---',
            'description: Ignored rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Ignored rule body',
            '',
          ].join('\n'),
          expectedManifestName: 'valid-rule',
          ignoredOutputPath: path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'instructions',
            'ignored-rule.instructions.md',
          ),
        },
      ] as const;

      describe('Given a source root contains one markdown file and one non-markdown file', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then only the markdown source is synced', () => {
            it.each(markdownDiscoveryScenarios)(
              'Examples: $sourceRootName',
              async ({
                expectedManifestName,
                ignoredContent,
                ignoredOutputPath,
                ignoredPath,
                validContent,
                validPath,
              }) => {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: validPath,
                  content: validContent,
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: ignoredPath,
                  content: ignoredContent,
                });
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(mockFileSystem.files.has(ignoredOutputPath)).toBe(false);
                expect(
                  readSyncManifest()
                    .outputs.map((entry) => entry.name)
                    .slice()
                    .sort(),
                ).toEqual([expectedManifestName, expectedManifestName]);
              },
            );
          });
        });
      });
    });

    describe('Scenario Outline: Discover command and rule files only at the top level', () => {
      const topLevelDiscoveryScenarios = [
        {
          sourceRootName: 'commands',
          topLevelPath: path.join(
            DEFAULT_CONFIG_ROOT,
            'commands',
            'top-command.md',
          ),
          nestedPath: path.join(
            DEFAULT_CONFIG_ROOT,
            'commands',
            'nested',
            'nested-command.md',
          ),
          topLevelContent: [
            '---',
            'name: top-command',
            'description: Top command',
            '---',
            '',
            'Top command body',
            '',
          ].join('\n'),
          nestedContent: [
            '---',
            'name: nested-command',
            'description: Nested command',
            '---',
            '',
            'Nested command body',
            '',
          ].join('\n'),
          expectedManifestName: 'top-command',
          nestedOutputPath: path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'nested-command.prompt.md',
          ),
        },
        {
          sourceRootName: 'rules',
          topLevelPath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'top-rule.md'),
          nestedPath: path.join(
            DEFAULT_CONFIG_ROOT,
            'rules',
            'nested',
            'nested-rule.md',
          ),
          topLevelContent: [
            '---',
            'description: Top rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Top rule body',
            '',
          ].join('\n'),
          nestedContent: [
            '---',
            'description: Nested rule',
            'agents:',
            '  copilot:',
            "    applyTo: '**'",
            '  cursor:',
            "    globs: '**'",
            '---',
            '',
            'Nested rule body',
            '',
          ].join('\n'),
          expectedManifestName: 'top-rule',
          nestedOutputPath: path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'instructions',
            'nested-rule.instructions.md',
          ),
        },
      ] as const;

      describe('Given a source root contains one top-level markdown file and one nested markdown file', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then only the top-level source is synced', () => {
            it.each(topLevelDiscoveryScenarios)(
              'Examples: $sourceRootName',
              async ({
                expectedManifestName,
                nestedContent,
                nestedOutputPath,
                nestedPath,
                topLevelContent,
                topLevelPath,
              }) => {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: topLevelPath,
                  content: topLevelContent,
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: nestedPath,
                  content: nestedContent,
                });
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  readSyncManifest()
                    .outputs.map((entry) => entry.name)
                    .slice()
                    .sort(),
                ).toEqual([expectedManifestName, expectedManifestName]);
                expect(mockFileSystem.files.has(nestedOutputPath)).toBe(false);
              },
            );
          });
        });
      });
    });

    describe('Scenario: Ignore files directly under the skills source root', () => {
      describe('Given the skills source root contains a loose file and a real skill directory', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then only the skill directory is synced', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'loose-skill.md',
                ),
                content: '# Loose skill file\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'real-skill',
                  'SKILL.md',
                ),
                content: '# Real skill\n',
              });
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'real-skill',
                    'SKILL.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'loose-skill.md',
                    'SKILL.md',
                  ),
                ),
              ).toBe(false);

              expect(
                readSyncManifest()
                  .outputs.map((entry) => entry.name)
                  .slice()
                  .sort(),
              ).toEqual(['real-skill', 'real-skill']);
            });
          });
        });
      });
    });

    // priority: low
    it.todo(
      'should discover skill directories with nested files without treating nested directories as separate skills',
    );
  });

  describe('Rule: Source changes update managed artifacts', () => {
    describe('Scenario Outline: Update generated outputs when source content changes', () => {
      describe('Given a source has already been synced', () => {
        describe('And the source content changes', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then the generated outputs and report are updated', () => {
              it.each([
                {
                  kind: 'command',
                  sourcePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'my-cmd.md',
                  ),
                  updatedSource: [
                    '---',
                    'name: my-cmd',
                    'description: Test command',
                    '---',
                    '',
                    'Updated command body',
                    '',
                  ].join('\n'),
                  outputPaths: [
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'prompts',
                      'my-cmd.prompt.md',
                    ),
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'my-cmd',
                      'SKILL.md',
                    ),
                  ],
                  expectedContent: 'Updated command body',
                  expectedReportLine: 'my-cmd (updated)',
                },
                {
                  kind: 'rule',
                  sourcePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'rules',
                    'my-rule.md',
                  ),
                  updatedSource: [
                    '---',
                    'description: Test rule',
                    'agents:',
                    '  copilot:',
                    "    applyTo: '**'",
                    '  cursor:',
                    "    globs: '**'",
                    '---',
                    '',
                    'Updated rule body',
                    '',
                  ].join('\n'),
                  outputPaths: [
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'instructions',
                      'my-rule.instructions.md',
                    ),
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'rules',
                      'my-rule.mdc',
                    ),
                  ],
                  expectedContent: 'Updated rule body',
                  expectedReportLine: 'my-rule (updated)',
                },
                {
                  kind: 'skill',
                  sourcePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'my-skill',
                    'SKILL.md',
                  ),
                  updatedSource: '# Updated Skill\n',
                  outputPaths: [
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'skills',
                      'my-skill',
                      'SKILL.md',
                    ),
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'my-skill',
                      'SKILL.md',
                    ),
                  ],
                  expectedContent: '# Updated Skill',
                  expectedReportLine: 'my-skill (updated)',
                },
              ] as const)(
                'Examples: $kind',
                async ({
                  expectedContent,
                  expectedReportLine,
                  outputPaths,
                  sourcePath,
                  updatedSource,
                }) => {
                  arrangeBasicSources();
                  const { cliOptions, stdoutMessages, stderrMessages } =
                    createTestEnv({ mockFileSystem });

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });
                  expect(stderrMessages).toEqual([]);

                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: sourcePath,
                    content: updatedSource,
                  });
                  clearCapturedOutput({ stdoutMessages, stderrMessages });

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  expect(stderrMessages).toEqual([]);
                  for (const outputPath of outputPaths) {
                    expect(
                      readMockTextFile({
                        handle: mockFileSystem,
                        filePath: outputPath,
                      }),
                    ).toContain(expectedContent);
                  }
                  expect(stripAnsi(stdoutMessages.join(''))).toContain(
                    expectedReportLine,
                  );
                },
              );
            });
          });
        });
      });
    });
  });

  describe('Rule: Drift in managed artifacts is repaired', () => {
    describe('Scenario Outline: Restore command outputs when on-disk output drifts from the source', () => {
      describe('Given a command output has already been synced', () => {
        describe('And the generated command output changes on disk', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> command output is restored and reported as updated', () => {
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
              ] as const)('Examples: $agent', async ({ driftPath }) => {
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

                clearCapturedOutput({ stdoutMessages, stderrMessages });

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
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Restore rule outputs when on-disk output drifts from the source', () => {
      describe('Given a rule output has already been synced', () => {
        describe('And the generated rule output changes on disk', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> rule output is restored and reported as updated', () => {
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
              ] as const)('Examples: $agent', async ({ driftPath }) => {
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

                clearCapturedOutput({ stdoutMessages, stderrMessages });

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
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Recopy a skill when SKILL.md drifts', () => {
      describe('Given a directory skill output has already been synced', () => {
        describe('And the generated SKILL.md changes on disk', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> skill output is recopied and reported as updated', () => {
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
              ] as const)('Examples: $agent', async ({ skillRoot }) => {
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

                clearCapturedOutput({ stdoutMessages, stderrMessages });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: skillMd,
                  }),
                ).toContain('# My Skill');
                const report = stripAnsi(stdoutMessages.join(''));
                expect(report).toMatch(/my-skill \(updated\)/);
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Recopy a skill when a non-SKILL.md file drifts', () => {
      describe('Given a directory skill with supporting files has already been synced', () => {
        describe('And a generated supporting file changes on disk', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> skill output is recopied and reported as updated', () => {
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
                  agentSkillsRoot: path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                  ),
                },
              ] as const)('Examples: $agent', async ({ agentSkillsRoot }) => {
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

                clearCapturedOutput({ stdoutMessages, stderrMessages });

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
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: skillMd,
                  }),
                ).toContain('Rich skill');
                const report = stripAnsi(stdoutMessages.join(''));
                expect(report).toMatch(
                  new RegExp(`${skillName} \\(updated\\)`),
                );
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Recreate SKILL.md when its output directory still exists', () => {
      describe('Given a generated SKILL.md has been removed from an existing output directory', () => {
        describe('When I run "dry-ai sync" again', () => {
          describe('Then <agent> recreates SKILL.md with the expected content', () => {
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
              'Examples: $agent ($scenario)',
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

                removeMockPath({
                  handle: mockFileSystem,
                  targetPath: skillMdPath,
                });

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
        });
      });
    });

    describe('Scenario Outline: Remove files from managed skill outputs when they are not in the source tree', () => {
      describe('Given a synced skill output directory contains an extra generated file', () => {
        describe('When I run "dry-ai sync" again', () => {
          describe('Then <agent> removes the extra file and reports the skill as updated', () => {
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
            ] as const)('Examples: $agent', async ({ skillRoot }) => {
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

              clearCapturedOutput({ stdoutMessages, stderrMessages });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(normalizeMockPath(strayFile)),
              ).toBe(false);
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(skillRoot, 'SKILL.md'),
                }),
              ).toContain('# My Skill');
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatch(/my-skill \(updated\)/);
            });
          });
        });
      });
    });
  });

  describe('Rule: Aligned sync state is a no-op', () => {
    describe('Scenario: Report no applied changes when sync state stays aligned', () => {
      describe('Given the config root has already been synced', () => {
        describe('And no sources or outputs have changed', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then the sync report says no changes were applied', () => {
              it('passes', async () => {
                arrangeBasicSources();

                const { cliOptions, stderrMessages, stdoutMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });
                expect(stderrMessages).toEqual([]);

                clearCapturedOutput({ stdoutMessages, stderrMessages });

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
          });
        });
      });
    });
  });

  describe('Rule: Removed sources prune managed artifacts and manifest rows', () => {
    describe('Scenario Outline: Remove generated agent output when a source file is deleted', () => {
      describe('Given a command source has already been synced', () => {
        describe('And the command source file is deleted', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> generated command output is removed', () => {
              it.each([
                { agent: 'copilot', label: 'Copilot' },
                { agent: 'cursor', label: 'Cursor' },
              ] as const)('Examples: $label', async ({ agent }) => {
                arrangeBasicSources();
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });
                expect(stderrMessages).toEqual([]);

                removeMockPath({
                  handle: mockFileSystem,
                  targetPath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'my-cmd.md',
                  ),
                });
                clearCapturedOutput({ stdoutMessages, stderrMessages });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  mockFileSystem.files.has(getBasicCommandOutputPath(agent)),
                ).toBe(false);
              });
            });
          });
        });
      });
    });

    describe('Scenario: Remove generated outputs for every agent when a source file is deleted', () => {
      describe('Given a command source has already been synced for every agent', () => {
        describe('And the command source file is deleted', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then every agent generated command output is removed', () => {
              it('passes', async () => {
                arrangeBasicSources();
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);

                removeMockPath({
                  handle: mockFileSystem,
                  targetPath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'my-cmd.md',
                  ),
                });
                clearCapturedOutput({ stdoutMessages, stderrMessages });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  mockFileSystem.files.has(
                    getBasicCommandOutputPath('copilot'),
                  ),
                ).toBe(false);
                expect(
                  mockFileSystem.files.has(getBasicCommandOutputPath('cursor')),
                ).toBe(false);
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Remove skill output directory when its source directory is deleted', () => {
      describe('Given a skill source has already been synced', () => {
        describe('And the skill source directory is deleted', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> skill output is removed and reported as removed', () => {
              it.each([
                {
                  agent: 'Copilot',
                  skillOutputPath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'my-skill',
                    'SKILL.md',
                  ),
                },
                {
                  agent: 'Cursor',
                  skillOutputPath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'my-skill',
                    'SKILL.md',
                  ),
                },
              ] as const)('Examples: $agent', async ({ skillOutputPath }) => {
                arrangeBasicSources();

                const { cliOptions, stderrMessages, stdoutMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(mockFileSystem.files.has(skillOutputPath)).toBe(true);

                removeMockPath({
                  handle: mockFileSystem,
                  targetPath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'my-skill',
                  ),
                });
                clearCapturedOutput({ stdoutMessages, stderrMessages });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(mockFileSystem.files.has(skillOutputPath)).toBe(false);
                expect(stripAnsi(stdoutMessages.join(''))).toContain(
                  'my-skill (removed)',
                );
              });
            });
          });
        });
      });
    });

    describe('Scenario Outline: Remove manifest rows when a source file is deleted', () => {
      describe('Given a command source has already been synced', () => {
        describe('And the command source file is deleted', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then <agent> command rows are removed from sync-manifest.json', () => {
              it.each([
                { agent: 'copilot', label: 'Copilot' },
                { agent: 'cursor', label: 'Cursor' },
              ] as const)('Examples: $label', async ({ agent }) => {
                arrangeBasicSources();
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });
                expect(stderrMessages).toEqual([]);

                removeMockPath({
                  handle: mockFileSystem,
                  targetPath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'my-cmd.md',
                  ),
                });
                clearCapturedOutput({ stdoutMessages, stderrMessages });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  readSyncManifest().outputs.some(
                    (entry) =>
                      entry.agent === agent &&
                      entry.kind === 'command' &&
                      entry.name === 'my-cmd',
                  ),
                ).toBe(false);
              });
            });
          });
        });
      });
    });

    describe('Scenario: Remove manifest rows for every agent when a source file is deleted', () => {
      describe('Given a command source has manifest rows for every agent', () => {
        describe('And the command source file is deleted', () => {
          describe('When I run "dry-ai sync" again', () => {
            describe('Then sync-manifest.json no longer contains command rows for that source', () => {
              it('passes', async () => {
                arrangeBasicSources();
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);

                const manifestBeforeDelete = readSyncManifest();
                expect(
                  manifestBeforeDelete.outputs.filter(
                    (entry) =>
                      entry.kind === 'command' && entry.name === 'my-cmd',
                  ),
                ).toHaveLength(2);

                removeMockPath({
                  handle: mockFileSystem,
                  targetPath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'my-cmd.md',
                  ),
                });
                clearCapturedOutput({ stdoutMessages, stderrMessages });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(readSyncManifest().outputs).toEqual(
                  buildExpectedManifestTrio(VIRTUAL_HOME_DIR)
                    .filter((entry) => entry.kind !== 'command')
                    .slice()
                    .sort(compareManifestEntryTuples),
                );
              });
            });
          });
        });
      });
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

      describe('Scenario: Prune manifest-tracked command outputs whose source no longer exists', () => {
        describe('Given the prior manifest tracks stale command outputs', () => {
          describe('And another command source still exists', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then stale command outputs are removed without short-circuiting current writes', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const { copilotOutputPath, cursorWritePath } =
                    arrangeStaleCommand();
                  const { cliOptions, stderrMessages } = createTestEnv({
                    mockFileSystem,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    true,
                  );
                  expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    false,
                  );
                  expect(mockFileSystem.files.has(cursorWritePath)).toBe(false);
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
                  expect(stderrMessages).toEqual([]);
                });
              });
            });
          });
        });
      });

      describe('Scenario: Prune manifest-tracked rule outputs whose source no longer exists', () => {
        describe('Given the prior manifest tracks stale rule outputs', () => {
          describe('And another command source still exists', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then stale rule outputs are removed', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const { copilotOutputPath, cursorOutputPath } =
                    arrangeStaleRule();
                  const { cliOptions, stderrMessages } = createTestEnv({
                    mockFileSystem,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    true,
                  );
                  expect(mockFileSystem.files.has(cursorOutputPath)).toBe(true);

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    false,
                  );
                  expect(mockFileSystem.files.has(cursorOutputPath)).toBe(
                    false,
                  );
                  expect(stderrMessages).toEqual([]);
                });
              });
            });
          });
        });
      });

      describe('Scenario: Prune manifest-tracked skill output trees whose source no longer exists', () => {
        describe('Given the prior manifest tracks stale skill directory outputs', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then entire stale skill output trees are removed', () => {
              it('passes', async () => {
                seedCurrentCommandSource();
                const { copilotInnerFiles, cursorInnerFiles } =
                  arrangeStaleSkill();
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                for (const filePath of [
                  ...copilotInnerFiles,
                  ...cursorInnerFiles,
                ]) {
                  expect(mockFileSystem.files.has(filePath)).toBe(true);
                }

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                for (const filePath of [
                  ...copilotInnerFiles,
                  ...cursorInnerFiles,
                ]) {
                  expect(mockFileSystem.files.has(filePath)).toBe(false);
                }
                expect(stderrMessages).toEqual([]);
              });
            });
          });
        });
      });

      describe('Scenario: Leave untracked target files unchanged while pruning stale outputs', () => {
        describe('Given a file under a target root was never listed in the manifest', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then the untracked file remains unchanged', () => {
              it('passes', async () => {
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

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(mockFileSystem.files.has(untrackedFilePath)).toBe(true);
                expect(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: untrackedFilePath,
                  }),
                ).toBe(untrackedFileContent);
                expect(stderrMessages).toEqual([]);
              });
            });
          });
        });
      });

      describe('Scenario: List pruned items as removed during mixed apply and removal runs', () => {
        describe('Given the prior manifest tracks stale command outputs', () => {
          describe('And another command source still exists', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then the report lists the pruned item as removed in each agent section', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  arrangeStaleCommand();
                  const { cliOptions, stdoutMessages, stderrMessages } =
                    createTestEnv({ mockFileSystem });

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  const stdout = stdoutMessages.join('');
                  expect(stdout).toMatch(/gone-cmd[^\n]*removed/);
                  expect(stdout).toContain('Copilot');
                  expect(stdout).toContain('Cursor');
                  expect(stderrMessages).toEqual([]);
                });
              });
            });
          });
        });
      });

      describe('when the prior sync-manifest.json is not strictly valid', () => {
        describe('Scenario: Preserve stale outputs when manifest strict validation fails', () => {
          describe('Given sync-manifest.json has an unsupported version and extra fields', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then stale outputs are preserved', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const {
                    copilotOutputPath,
                    cursorWritePath,
                    cursorOutputDir,
                  } = arrangeStaleCommand();

                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
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

                  const { cliOptions } = createTestEnv({ mockFileSystem });

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    true,
                  );
                  expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);
                });
              });
            });
          });
        });

        describe('Scenario: Warn when manifest strict validation fails', () => {
          describe('Given sync-manifest.json has an unsupported version and extra fields', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then a manifest layout warning is emitted', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const { copilotOutputPath, cursorOutputDir } =
                    arrangeStaleCommand();

                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
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

                  expect(stderrMessages).toHaveLength(1);
                  expect(stripAnsi(stderrMessages.join(''))).toMatch(
                    /did not match the expected layout/i,
                  );
                });
              });
            });
          });
        });

        describe('Scenario: Preserve stale outputs when sync-manifest.json is not valid JSON', () => {
          describe('Given sync-manifest.json cannot be parsed as JSON', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then stale outputs are preserved', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const { copilotOutputPath, cursorWritePath } =
                    arrangeStaleCommand();
                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
                    content: '{ not json',
                  });

                  const { cliOptions } = createTestEnv({ mockFileSystem });

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    true,
                  );
                  expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);
                });
              });
            });
          });
        });

        describe('Scenario: Warn when sync-manifest.json is not valid JSON', () => {
          describe('Given sync-manifest.json cannot be parsed as JSON', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then a damaged manifest warning is emitted', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  arrangeStaleCommand();
                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
                    content: '{ not json',
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
                    /damaged or incomplete/i,
                  );
                });
              });
            });
          });
        });

        describe('Scenario: Preserve stale outputs when manifest output rows are invalid', () => {
          describe('Given sync-manifest.json contains invalid output rows', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then stale outputs are preserved', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const { copilotOutputPath, cursorWritePath } =
                    arrangeStaleCommand();
                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
                    content: JSON.stringify({
                      version: MOCK_SYNC_MANIFEST_VERSION,
                      outputs: [
                        {
                          agent: 'copilot',
                          kind: 'unknown-kind',
                          name: 'gone-cmd',
                          outputPath: copilotOutputPath,
                        },
                      ],
                    }),
                  });

                  const { cliOptions } = createTestEnv({ mockFileSystem });

                  await runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  });

                  expect(mockFileSystem.files.has(copilotOutputPath)).toBe(
                    true,
                  );
                  expect(mockFileSystem.files.has(cursorWritePath)).toBe(true);
                });
              });
            });
          });
        });

        describe('Scenario: Warn when manifest output rows are invalid', () => {
          describe('Given sync-manifest.json contains invalid output rows', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then a manifest layout warning is emitted', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  const { copilotOutputPath } = arrangeStaleCommand();
                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
                    content: JSON.stringify({
                      version: MOCK_SYNC_MANIFEST_VERSION,
                      outputs: [
                        {
                          agent: 'copilot',
                          kind: 'unknown-kind',
                          name: 'gone-cmd',
                          outputPath: copilotOutputPath,
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

                  expect(stderrMessages).toHaveLength(1);
                  expect(stripAnsi(stderrMessages.join(''))).toMatch(
                    /did not match the expected layout/i,
                  );
                });
              });
            });
          });
        });

        describe('Scenario: Warn when strict validation fails with empty manifest outputs', () => {
          describe('Given sync-manifest.json has an unsupported version and no outputs', () => {
            describe('When I run "dry-ai sync"', () => {
              describe('Then a manifest layout warning is emitted', () => {
                it('passes', async () => {
                  seedCurrentCommandSource();
                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
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
        });
      });
    });
  });

  describe('Rule: Ownership conflicts skip only conflicting artifacts', () => {
    describe('Scenario: Keep non-conflicting Copilot outputs when Cursor outputs conflict', () => {
      describe('Given a command and skill collide in the Cursor skill namespace', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the non-conflicting Copilot outputs are written', () => {
            it('passes', async () => {
              arrangeCursorSkillNameConflict();
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'shared-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'shared',
                    'SKILL.md',
                  ),
                ),
              ).toBe(true);
            });
          });
        });
      });
    });

    describe('Scenario: Skip the conflicting Cursor output', () => {
      describe('Given a command and skill collide in the Cursor skill namespace', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the conflicting Cursor output is not written', () => {
            it('passes', async () => {
              arrangeCursorSkillNameConflict();
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'shared',
                    'SKILL.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Write manifest rows and report text only for non-conflicting outputs', () => {
      describe('Given a command and skill collide in the Cursor skill namespace', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the manifest and report include only non-conflicting outputs', () => {
            it('passes', async () => {
              arrangeCursorSkillNameConflict();

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(readSyncManifest().outputs).toEqual([
                {
                  agent: 'copilot',
                  kind: 'command',
                  name: 'shared',
                  outputPath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'shared-command.prompt.md',
                  ),
                },
                {
                  agent: 'copilot',
                  kind: 'skill',
                  name: 'shared',
                  outputPath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'shared',
                  ),
                },
              ]);

              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toMatchInlineSnapshot(`
              "Applied changes:

              - Copilot
                * commands
                  - shared (installed)
                * skills
                  - shared (installed)

              Skipped conflicts:
              - command "shared" from /virtual/home/.config/dry-ai/commands/shared-command.md
                * due to: Cursor skill name "shared"
              - skill "shared" from /virtual/home/.config/dry-ai/skills/shared
                * due to: Cursor skill name "shared"
              "
            `);
            });
          });
        });
      });
    });

    it.todo(
      'should fail fast when two registered agents produce the same ownership key for different layouts',
    );

    describe('for registered target trees', () => {
      // priority: low
      it.todo(
        'should place partial writes on the expected per-agent paths with the expected file types when one agent block is invalid and the other still syncs',
      );

      // priority: low
      it.todo(
        'should keep every registry agent covered by an explicit ownership-key expectation for command, rule, and skill outputs',
      );
    });

    describe('namespace collisions and skipped items', () => {
      describe('Scenario: Skip only Cursor outputs when two commands share the same Cursor skill name', () => {
        describe('Given two command sources resolve to the same Cursor skill name', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then Copilot outputs are written and Cursor outputs are skipped with conflict details', () => {
              it('passes', async () => {
                for (const fileStem of ['first-cmd', 'second-cmd'] as const) {
                  storeMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'commands',
                      `${fileStem}.md`,
                    ),
                    content: [
                      '---',
                      'name: shared-command-name',
                      `description: ${fileStem}`,
                      '---',
                      '',
                      `${fileStem} body`,
                      '',
                    ].join('\n'),
                  });
                }
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'prompts',
                      'first-cmd.prompt.md',
                    ),
                  ),
                ).toBe(true);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'prompts',
                      'second-cmd.prompt.md',
                    ),
                  ),
                ).toBe(true);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'shared-command-name',
                      'SKILL.md',
                    ),
                  ),
                ).toBe(false);
                const report = stripAnsi(stdoutMessages.join(''));
                expect(
                  report.match(/shared-command-name \(installed\)/g),
                ).toHaveLength(2);
                expect(report).toMatch(
                  /command "shared-command-name" from .*first-cmd\.md/,
                );
                expect(report).toMatch(
                  /command "shared-command-name" from .*second-cmd\.md/,
                );
                expect(report).toContain(
                  'Cursor skill name "shared-command-name"',
                );
              });
            });
          });
        });
      });

      describe('Scenario: Skip Cursor outputs that share a command and skill namespace', () => {
        describe('Given a command and skill source share the same Cursor skill name', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then Cursor output is skipped with conflict details for both sources', () => {
              it('passes', async () => {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'shared-command.md',
                  ),
                  content: [
                    '---',
                    'name: shared',
                    'description: Shared command',
                    '---',
                    '',
                    'Command body',
                    '',
                  ].join('\n'),
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'shared',
                    'SKILL.md',
                  ),
                  content: '# Shared skill\n',
                });
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'shared',
                      'SKILL.md',
                    ),
                  ),
                ).toBe(false);
                const report = stripAnsi(stdoutMessages.join(''));
                expect(report).toMatch(
                  /command "shared" from .*shared-command\.md/,
                );
                expect(report).toMatch(/skill "shared" from .*skills\/shared/);
                expect(report).toContain('Cursor skill name "shared"');
              });
            });
          });
        });
      });

      describe('Scenario: Still sync non-conflicting items when other items are skipped for conflicts', () => {
        describe('Given some sources conflict and another rule source does not conflict', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then non-conflicting outputs are written and conflicts are reported', () => {
              it('passes', async () => {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'shared-command.md',
                  ),
                  content: [
                    '---',
                    'name: shared',
                    'description: Shared command',
                    '---',
                    '',
                    'Command body',
                    '',
                  ].join('\n'),
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'shared',
                    'SKILL.md',
                  ),
                  content: '# Shared skill\n',
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'rules',
                    'valid-rule.md',
                  ),
                  content: [
                    '---',
                    'description: Valid rule',
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
                const { cliOptions, stdoutMessages, stderrMessages } =
                  createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'instructions',
                      'valid-rule.instructions.md',
                    ),
                  ),
                ).toBe(true);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'rules',
                      'valid-rule.mdc',
                    ),
                  ),
                ).toBe(true);
                const report = stripAnsi(stdoutMessages.join(''));
                expect(report).toMatch(/valid-rule \(installed\)/);
                expect(report).toContain('Skipped conflicts:');
              });
            });
          });
        });
      });

      // priority: low
      it.todo(
        'should list skipped conflict lines in alphabetical order by source item label',
      );

      // priority: low
      it.todo(
        'should keep manifest entries for conflict-skipped items when merge rules require it for this run',
      );

      describe('Scenario: Preserve old output for a conflict-skipped item that would otherwise be pruned', () => {
        describe('Given the manifest tracks an old output for a source that now conflicts', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then the conflict-skipped output and manifest row are preserved', () => {
              it('passes', async () => {
                const preservedOutputDir = path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'shared',
                );
                const preservedWritePath = path.join(
                  preservedOutputDir,
                  'SKILL.md',
                );
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: preservedWritePath,
                  content: '# old shared\n',
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'sync-manifest.json',
                  ),
                  content: JSON.stringify({
                    version: MOCK_SYNC_MANIFEST_VERSION,
                    outputs: [
                      {
                        agent: 'cursor',
                        kind: 'command',
                        name: 'shared',
                        outputPath: preservedOutputDir,
                      },
                    ],
                  }),
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'shared-command.md',
                  ),
                  content: [
                    '---',
                    'name: shared',
                    'description: Shared command',
                    '---',
                    '',
                    'Command body',
                    '',
                  ].join('\n'),
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'shared',
                    'SKILL.md',
                  ),
                  content: '# New shared skill\n',
                });
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: preservedWritePath,
                  }),
                ).toBe('# old shared\n');
                const manifest = mockSyncManifestSchema.parse(
                  JSON.parse(
                    readMockTextFile({
                      handle: mockFileSystem,
                      filePath: path.join(
                        DEFAULT_CONFIG_ROOT,
                        'sync-manifest.json',
                      ),
                    }),
                  ),
                );
                expect(manifest.outputs).toContainEqual({
                  agent: 'cursor',
                  kind: 'command',
                  name: 'shared',
                  outputPath: preservedOutputDir,
                });
              });
            });
          });
        });
      });

      describe('Scenario: Keep non-conflicting agent outputs when another agent target collides', () => {
        describe('Given a command and skill collide only for one agent target', () => {
          describe('When I run "dry-ai sync"', () => {
            describe('Then non-conflicting agent outputs are written and the colliding target is skipped', () => {
              it('passes', async () => {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'commands',
                    'shared-command.md',
                  ),
                  content: [
                    '---',
                    'name: shared',
                    'description: Shared command',
                    '---',
                    '',
                    'Command body',
                    '',
                  ].join('\n'),
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'shared',
                    'SKILL.md',
                  ),
                  content: '# Shared skill\n',
                });
                const { cliOptions, stderrMessages } = createTestEnv({
                  mockFileSystem,
                });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(stderrMessages).toEqual([]);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'prompts',
                      'shared-command.prompt.md',
                    ),
                  ),
                ).toBe(true);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.copilot',
                      'skills',
                      'shared',
                      'SKILL.md',
                    ),
                  ),
                ).toBe(true);
                expect(
                  mockFileSystem.files.has(
                    path.join(
                      VIRTUAL_HOME_DIR,
                      '.cursor',
                      'skills',
                      'shared',
                      'SKILL.md',
                    ),
                  ),
                ).toBe(false);
              });
            });
          });
        });
      });

      // priority: low
      it.todo(
        'should dedupe multiple conflict descriptions for the same source before rendering Skipped conflicts',
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

  describe('Rule: Frontmatter is validated and scoped per agent', () => {
    describe('Scenario Outline: Write valid command output when another agent block is invalid', () => {
      describe('Given a command source has one valid agent block and one invalid agent block', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <validAgent> command output is written and the invalid agent output is skipped', () => {
            it.each([
              {
                validAgent: 'Copilot',
                fileStem: 'bad-cursor-cmd',
                sourceLines: [
                  'agents:',
                  '  copilot: {}',
                  '  cursor: invalid-cursor-section',
                ],
                validOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'bad-cursor-cmd.prompt.md',
                ),
                invalidOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'my-cmd',
                  'SKILL.md',
                ),
              },
              {
                validAgent: 'Cursor',
                fileStem: 'bad-copilot-cmd',
                sourceLines: [
                  'agents:',
                  '  copilot: invalid-copilot-section',
                  '  cursor: {}',
                ],
                validOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'my-cmd',
                  'SKILL.md',
                ),
                invalidOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'bad-copilot-cmd.prompt.md',
                ),
              },
            ] as const)(
              'Examples: $validAgent',
              async ({
                fileStem,
                invalidOutputPath,
                sourceLines,
                validOutputPath,
              }) => {
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
                    ...sourceLines,
                    '---',
                    '',
                    'Command body',
                    '',
                  ].join('\n'),
                });

                const { cliOptions } = createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(mockFileSystem.files.has(validOutputPath)).toBe(true);
                expect(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: validOutputPath,
                  }),
                ).toContain('Command body');
                expect(mockFileSystem.files.has(invalidOutputPath)).toBe(false);
              },
            );
          });
        });
      });
    });

    describe('Scenario: Write Cursor rule output when alwaysApply omits globs', () => {
      describe('Given a Cursor rule sets alwaysApply without globs', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the Cursor rule file is written', () => {
            it('passes', async () => {
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

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'cursor-always-apply.mdc',
                  ),
                ),
              ).toBe(true);
            });
          });
        });
      });
    });

    describe('Scenario Outline: Write valid rule output when another agent block is invalid', () => {
      describe('Given a rule source has one valid agent block and one invalid agent block', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then <validAgent> rule output is written and the invalid agent output is skipped', () => {
            it.each([
              {
                validAgent: 'Copilot',
                fileStem: 'bad-cursor-block',
                sourceLines: [
                  '  copilot:',
                  "    applyTo: '**'",
                  '  cursor: invalid-cursor-section',
                ],
                validOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'bad-cursor-block.instructions.md',
                ),
                invalidOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'bad-cursor-block.mdc',
                ),
              },
              {
                validAgent: 'Cursor',
                fileStem: 'bad-copilot-block',
                sourceLines: [
                  '  copilot: invalid-copilot-section',
                  '  cursor:',
                  "    globs: '**'",
                ],
                validOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'bad-copilot-block.mdc',
                ),
                invalidOutputPath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'bad-copilot-block.instructions.md',
                ),
              },
            ] as const)(
              'Examples: $validAgent',
              async ({
                fileStem,
                invalidOutputPath,
                sourceLines,
                validOutputPath,
              }) => {
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'rules',
                    `${fileStem}.md`,
                  ),
                  content: [
                    '---',
                    'description: Test rule',
                    'agents:',
                    ...sourceLines,
                    '---',
                    '',
                    'Body',
                    '',
                  ].join('\n'),
                });

                const { cliOptions } = createTestEnv({ mockFileSystem });

                await runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                });

                expect(mockFileSystem.files.has(validOutputPath)).toBe(true);
                expect(mockFileSystem.files.has(invalidOutputPath)).toBe(false);
              },
            );
          });
        });
      });
    });

    // Skills: sync copies trees and does not parse SKILL.md like command/rule
    // markdown; other commands may validate skills.

    describe('Scenario: Skip a command when top-level frontmatter fails validation', () => {
      describe('Given a command source is missing required top-level frontmatter', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the command is reported as skipped and no output is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'invalid-command.md',
                ),
                content: [
                  '---',
                  'name: invalid-command',
                  '---',
                  '',
                  'Invalid command body',
                  '',
                ].join('\n'),
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toMatch(
                /Skipping invalid frontmatter in .*invalid-command\.md.*description/s,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'invalid-command.prompt.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Skip a rule when top-level frontmatter fails validation', () => {
      describe('Given a rule source is missing required top-level frontmatter', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the rule is reported as skipped and no output is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'invalid-rule.md',
                ),
                content: [
                  '---',
                  'agents:',
                  '  copilot:',
                  "    applyTo: '**'",
                  '---',
                  '',
                  'Body',
                ].join('\n'),
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toMatch(
                /Skipping invalid frontmatter in .*invalid-rule\.md.*description/s,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'invalid-rule.instructions.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Keep syncing after one command or rule is skipped for invalid frontmatter', () => {
      describe('Given one command has invalid frontmatter and another command is valid', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the invalid command is skipped and the valid command is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'invalid-command.md',
                ),
                content: [
                  '---',
                  'name: invalid-command',
                  '---',
                  '',
                  'Invalid body',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'valid-command.md',
                ),
                content: [
                  '---',
                  'name: valid-command',
                  'description: Valid command',
                  '---',
                  '',
                  'Valid body',
                  '',
                ].join('\n'),
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toMatch(
                /Skipping invalid frontmatter in .*invalid-command\.md.*description/s,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'valid-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'invalid-command.prompt.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Skip a command agent output when its per-agent block fails validation', () => {
      describe('Given a command source has an invalid Cursor agent block and a valid Copilot block', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then Cursor is reported as skipped and only the Copilot command output is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'bad-agent-command.md',
                ),
                content: [
                  '---',
                  'name: bad-agent-command',
                  'description: Bad agent command',
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

              expect(stripAnsi(stderrMessages.join(''))).toMatch(
                /Skipping Cursor for .*bad-agent-command\.md.*agents\.cursor/s,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'bad-agent-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'bad-agent-command',
                    'SKILL.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Skip a rule agent output when its per-agent block fails validation', () => {
      describe('Given a rule source has an invalid Cursor agent block and a valid Copilot block', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then Cursor is reported as skipped and only the Copilot rule output is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'bad-agent-rule.md',
                ),
                content: [
                  '---',
                  'description: Bad agent rule',
                  'agents:',
                  '  copilot:',
                  "    applyTo: '**'",
                  '  cursor: invalid-cursor-section',
                  '---',
                  '',
                  'Rule body',
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

              expect(stripAnsi(stderrMessages.join(''))).toMatch(
                /Skipping Cursor for .*bad-agent-rule\.md.*agents\.cursor/s,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'bad-agent-rule.instructions.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'bad-agent-rule.mdc',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Skip a command when the agents block names an unregistered id', () => {
      describe('Given a command source names an unknown agent', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the command is skipped and the agent is named as unsupported', () => {
            // priority: low
            it.todo(
              'should skip a command and name unknown agents as Unsupported agent when the agents block names an unregistered id',
            );
          });
        });
      });
    });

    describe('Scenario: Skip a rule when the agents block names an unregistered id', () => {
      describe('Given a rule source names an unknown agent', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the rule is skipped and the agent is named as unsupported', () => {
            // priority: low
            it.todo(
              'should skip a rule and name unknown agents as Unsupported agent when the agents block names an unregistered id',
            );
          });
        });
      });
    });

    describe('Scenario: Use top-level command fields when the agents block is omitted', () => {
      describe('Given a command source has only top-level frontmatter fields', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then both agent outputs use the top-level command fields', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'top-level-command.md',
                ),
                content: [
                  '---',
                  'name: top-level-command',
                  'description: Top level command description',
                  '---',
                  '',
                  'Command body from top-level fields',
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
              const copilotPrompt = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'top-level-command.prompt.md',
                ),
              });
              const cursorSkill = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'top-level-command',
                  'SKILL.md',
                ),
              });
              expect(copilotPrompt).toContain('name: top-level-command');
              expect(copilotPrompt).toContain(
                'description: Top level command description',
              );
              expect(cursorSkill).toContain('name: top-level-command');
              expect(cursorSkill).toContain(
                'description: Top level command description',
              );
            });
          });
        });
      });
    });

    describe('Scenario: Use rule defaults when the matching agents block is omitted', () => {
      describe('Given a valid rule source has no agents block', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each agent rule file carries only top-level description', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'default-rule.md',
                ),
                content: [
                  '---',
                  'description: Rule with default agent settings',
                  '---',
                  '',
                  'Default rule body',
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
              const copilotRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'default-rule.instructions.md',
                ),
              });
              const cursorRule = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'default-rule.mdc',
                ),
              });
              expect(copilotRule).toContain(
                'description: Rule with default agent settings',
              );
              expect(copilotRule).not.toContain('applyTo:');
              expect(cursorRule).toContain(
                'description: Rule with default agent settings',
              );
              expect(cursorRule).not.toContain('alwaysApply:');
              expect(cursorRule).not.toContain('globs:');
            });
          });
        });
      });
    });

    describe('Scenario: Warn and skip without partial outputs when frontmatter parses but validation fails', () => {
      describe('Given a command source has parseable frontmatter that fails validation', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then no outputs or manifest rows are written for that file', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'invalid-command.md',
                ),
                content: [
                  '---',
                  'name: invalid-command',
                  '---',
                  '',
                  'Invalid command body',
                  '',
                ].join('\n'),
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toMatch(
                /Skipping invalid frontmatter in .*invalid-command\.md.*description/s,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'invalid-command.prompt.md',
                  ),
                ),
              ).toBe(false);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'skills',
                    'invalid-command',
                    'SKILL.md',
                  ),
                ),
              ).toBe(false);
              const manifest = mockSyncManifestSchema.parse(
                JSON.parse(
                  readMockTextFile({
                    handle: mockFileSystem,
                    filePath: path.join(
                      DEFAULT_CONFIG_ROOT,
                      'sync-manifest.json',
                    ),
                  }),
                ),
              );
              expect(manifest.outputs).toEqual([]);
            });
          });
        });
      });
    });

    describe('Scenario: Handle a command or rule file with no closing frontmatter delimiter', () => {
      describe('Given a command or rule source starts frontmatter without closing it', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the user-visible contract is clear', () => {
            // priority: low
            it.todo(
              'should follow one clear user-visible contract for a command or rule file with no closing frontmatter delimiter',
            );
          });
        });
      });
    });

    describe('Scenario: Handle a command whose body is empty after trim', () => {
      describe('Given a command source has valid frontmatter and an empty body', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then it either writes only frontmatter or skips with documented behavior', () => {
            // priority: low
            it.todo(
              'should either write only frontmatter or skip with documented behavior for a command whose body is empty after trim',
            );
          });
        });
      });
    });

    describe('Scenario: Handle invalid YAML in command or rule frontmatter', () => {
      describe('Given a command or rule source has invalid YAML frontmatter', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the user-visible contract is clear', () => {
            // priority: low
            it.todo(
              'should follow one clear user-visible contract for invalid YAML in command or rule frontmatter',
            );
          });
        });
      });
    });

    describe('Scenario: Keep Cursor command metadata out of the Copilot command prompt', () => {
      describe('Given a command source defines Cursor-specific metadata', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the Copilot prompt excludes Cursor metadata and the Cursor skill keeps it', () => {
            it('passes', async () => {
              const fileStem = 'scoped-command-metadata';
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  `${fileStem}.md`,
                ),
                content: [
                  '---',
                  'name: scoped-cmd',
                  'description: Test command',
                  'agents:',
                  '  copilot: {}',
                  '  cursor:',
                  '    disable-model-invocation: true',
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

              expect(stderrMessages).toEqual([]);

              const copilotPrompt = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  `${fileStem}.prompt.md`,
                ),
              });
              const cursorSkill = readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  'scoped-cmd',
                  'SKILL.md',
                ),
              });

              expect(copilotPrompt).not.toContain('disable-model-invocation');
              expect(cursorSkill).toContain('disable-model-invocation: true');
            });
          });
        });
      });
    });
  });

  describe('Rule: CLI roots determine source, output, and manifest locations', () => {
    describe('Scenario: Report the output root only when --output-root is explicitly set', () => {
      describe('Given basic sources exist', () => {
        describe('When I run "dry-ai sync" with and without --output-root', () => {
          describe('Then only the explicit --output-root run prints the output root', () => {
            it('passes', async () => {
              arrangeBasicSources();

              const defaultRun = createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...defaultRun.cliOptions,
              });

              expect(defaultRun.stderrMessages).toEqual([]);
              expect(
                stripAnsi(defaultRun.stdoutMessages.join('')),
              ).not.toContain('Generated output written to');

              mockFileSystem = createMockFileSystemState();
              clearMockFileSystemFailures(mockFileSystem);
              configureMockFileSystem({ handle: mockFileSystem });
              arrangeBasicSources();
              const explicitOutputRoot = '/virtual/custom-output';
              const explicitRun = createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['--output-root', explicitOutputRoot, 'sync'],
                ...explicitRun.cliOptions,
              });

              expect(explicitRun.stderrMessages).toEqual([]);
              expect(stripAnsi(explicitRun.stdoutMessages.join(''))).toContain(
                `Generated output written to ${explicitOutputRoot}`,
              );
            });
          });
        });
      });
    });

    describe('Scenario: Print the resolved output root when --test is set', () => {
      describe('Given basic sources exist', () => {
        describe('When I run "dry-ai --test sync"', () => {
          describe('Then stdout includes the resolved output-test root', () => {
            it('passes', async () => {
              arrangeBasicSources();
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });
              const expectedOutputRoot = path.resolve('./output-test');

              await runCLI({
                argv: ['--test', 'sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toContain(
                `Generated output written to ${expectedOutputRoot}`,
              );
            });
          });
        });
      });
    });

    describe('Scenario: Use --output-root for every agent output and manifest path', () => {
      describe('Given basic sources exist and --output-root is set', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then every agent output and manifest path uses that root with the expected layout', () => {
            it.todo(
              "when --output-root is set, every agent's observable outputs and manifest paths use that root with the expected layout",
            );
          });
        });
      });
    });

    describe('Scenario: Read sources from an absolute config root while using the default output tree', () => {
      describe('Given a command source exists under an absolute config root', () => {
        describe('When I run "dry-ai --config-root <configRoot> sync"', () => {
          describe('Then the output uses the default tree and the manifest is written under the config root', () => {
            it('passes', async () => {
              const configRoot = '/virtual/custom-config';
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  configRoot,
                  'commands',
                  'custom-command.md',
                ),
                content: [
                  '---',
                  'name: custom-command',
                  'description: Custom command',
                  '---',
                  '',
                  'Custom command body',
                  '',
                ].join('\n'),
              });
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['--config-root', configRoot, 'sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'custom-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(configRoot, 'sync-manifest.json'),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Write outputs under output-test while reading config from --config-root', () => {
      describe('Given a command source exists under a custom config root', () => {
        describe('When I run "dry-ai --config-root <configRoot> --test sync"', () => {
          describe('Then outputs use ./output-test and the manifest stays under the config root', () => {
            it('passes', async () => {
              const configRoot = '/virtual/test-config';
              const expectedOutputRoot = path.resolve('./output-test');
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(configRoot, 'commands', 'test-command.md'),
                content: [
                  '---',
                  'name: test-command',
                  'description: Test command',
                  '---',
                  '',
                  'Test command body',
                  '',
                ].join('\n'),
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['--config-root', configRoot, '--test', 'sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toContain(
                `Generated output written to ${expectedOutputRoot}`,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    expectedOutputRoot,
                    '.copilot',
                    'prompts',
                    'test-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(configRoot, 'sync-manifest.json'),
                ),
              ).toBe(true);
            });
          });
        });
      });
    });

    describe('Scenario: Place all agent trees under --output-root while keeping the manifest under the config root', () => {
      describe('Given basic sources exist and an explicit output root is set', () => {
        describe('When I run "dry-ai --output-root <outputRoot> sync"', () => {
          describe('Then all agent outputs use the output root and the manifest stays under the config root', () => {
            it('passes', async () => {
              const outputRoot = '/virtual/output-root';
              arrangeBasicSources();
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['--output-root', outputRoot, 'sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              for (const filePath of buildExpectedTrioProductFilePaths(
                outputRoot,
              )) {
                expect(mockFileSystem.files.has(filePath)).toBe(true);
              }
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Expand leading tildes in config and output roots', () => {
      describe('Given --config-root or --output-root starts with ~', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the path is expanded to the user home directory', () => {
            // priority: low
            it.todo(
              'should expand a leading ~ in --config-root and --output-root to the user home directory the same way as the rest of the CLI',
            );
          });
        });
      });
    });

    describe('Scenario: Prefer --output-root when --test is also passed', () => {
      describe('Given basic sources exist and both --test and --output-root are passed', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then outputs use --output-root instead of ./output-test', () => {
            it('passes', async () => {
              const outputRoot = '/virtual/explicit-output';
              arrangeBasicSources();
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['--test', '--output-root', outputRoot, 'sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(stripAnsi(stdoutMessages.join(''))).toContain(
                `Generated output written to ${outputRoot}`,
              );
              expect(
                mockFileSystem.files.has(
                  path.join(
                    outputRoot,
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    path.resolve('./output-test'),
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Keep --config-root from changing the output root', () => {
      describe('Given a command source exists under a custom config root', () => {
        describe('When I run "dry-ai --config-root <configRoot> sync"', () => {
          describe('Then the output still uses the default output root and the manifest uses the config root', () => {
            it('passes', async () => {
              const configRoot = '/virtual/config-only-root';
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  configRoot,
                  'commands',
                  'config-only-command.md',
                ),
                content: [
                  '---',
                  'name: config-only-command',
                  'description: Config-only command',
                  '---',
                  '',
                  'Config-only body',
                  '',
                ].join('\n'),
              });
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['--config-root', configRoot, 'sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'config-only-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(configRoot, 'sync-manifest.json'),
                ),
              ).toBe(true);
            });
          });
        });
      });
    });

    describe('Scenario: Reject an unsupported CLI flag', () => {
      describe('Given an unsupported flag is passed to dry-ai sync', () => {
        describe('When I run the CLI', () => {
          describe('Then Commander reports an unknownOption error', () => {
            it('passes', async () => {
              const { cliOptions, stderrMessages, stdoutMessages } =
                createTestEnv({ mockFileSystem });

              const error = await runCLIExpectingError({
                argv: ['--bogus', 'sync'],
                ...cliOptions,
              });

              expect(error).toBeInstanceOf(CommanderError);
              expect(error.code).toBe('commander.unknownOption');
              expect(error.exitCode).toBe(1);
              expect(stdoutMessages).toEqual([]);
              expect(stderrMessages.join('')).toContain(
                "unknown option '--bogus'",
              );
            });
          });
        });
      });
    });

    describe('Scenario: Reject a missing config root path', () => {
      describe('Given the configured config root does not exist on disk', () => {
        describe('When I run "dry-ai --config-root <missingConfigRoot> sync"', () => {
          describe('Then the CLI throws a clear error and does not write a manifest', () => {
            it('passes', async () => {
              const missingConfigRoot = '/virtual/missing-config-root';
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await expect(
                runCLI({
                  argv: ['--config-root', missingConfigRoot, 'sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow(
                `Config root does not exist: ${missingConfigRoot}`,
              );

              expect(stderrMessages).toEqual([]);
              expect(
                mockFileSystem.files.has(
                  path.join(missingConfigRoot, 'sync-manifest.json'),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });
  });

  describe('Rule: Registry and manifest metadata are validated before sync work proceeds', () => {
    describe('Scenario: Fail when the manifest names an agent that no longer exists', () => {
      describe('Given sync-manifest.json references an unregistered agent', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the run fails with a repair hint and leaves the stale output in place', () => {
            it('passes', async () => {
              const staleOutputPath = path.join(
                VIRTUAL_HOME_DIR,
                '.retired-agent',
                'commands',
                'old.md',
              );
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: staleOutputPath,
                content: '# old output\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                content: JSON.stringify({
                  version: MOCK_SYNC_MANIFEST_VERSION,
                  outputs: [
                    {
                      agent: 'retired-agent',
                      kind: 'command',
                      name: 'old',
                      outputPath: staleOutputPath,
                    },
                  ],
                }),
              });

              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await expect(
                runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow(
                /sync-manifest\.json references unregistered agent "retired-agent"\. Remove entries for "retired-agent" from sync-manifest\.json, or delete sync-manifest\.json to rebuild it on the next sync\./,
              );

              expect(mockFileSystem.files.has(staleOutputPath)).toBe(true);
              expect(stderrMessages).toEqual([]);
            });
          });
        });
      });
    });

    describe('Scenario: Fail when the manifest contains an output kind no registered agent can own', () => {
      describe('Given sync-manifest.json references an unsupported output kind', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the run fails before applying changes', () => {
            it.todo(
              'should fail the run when the manifest contains an output kind no registered agent can own',
            );
          });
        });
      });
    });

    describe('Scenario: Keep manifest validation errors distinct from ownership conflicts', () => {
      describe('Given sync-manifest.json is invalid and outputs could also conflict', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the manifest validation error is reported separately', () => {
            it.todo(
              'should keep manifest validation errors distinct from ownership conflicts',
            );
          });
        });
      });
    });

    describe('Scenario: Explain how to repair a manifest that references an unsupported agent or kind', () => {
      describe('Given sync-manifest.json references unsupported registry data', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the error explains how to repair the manifest', () => {
            it.todo(
              'should explain how to repair a manifest that references an unsupported agent or kind',
            );
          });
        });
      });
    });

    describe('Scenario: Follow registry order for Applied changes when registry order changes', () => {
      describe('Given the registry order changes', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then stdout follows registry order for Applied changes sections', () => {
            // priority: low
            it.todo(
              'should follow registry order for Applied changes sections in stdout when agent order in the registry changes',
            );
          });
        });
      });
    });

    describe('Scenario: Render a readable report when registry display labels are missing or reused', () => {
      describe('Given a registry display label is missing or reused', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report has no duplicate or empty agent headings', () => {
            // priority: low
            it.todo(
              'should still render a readable report without duplicate or empty agent headings when a registry display label is missing or reused',
            );
          });
        });
      });
    });

    describe('Scenario: Reject stale manifest rows before stale-output cleanup', () => {
      describe('Given the manifest references a stale or invalid registry', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then stale rows are rejected before their output paths are used for cleanup', () => {
            // priority: low
            it.todo(
              'should reject stale manifest rows before using their output paths for stale-output cleanup',
            );
          });
        });
      });
    });
  });

  describe('Rule: Filesystem failures fail the run without silent partial success', () => {
    describe('Scenario: Surface read errors for discovered files', () => {
      describe('Given a discovered command file cannot be read', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the filesystem read error is surfaced instead of treating the file as a normal skip', () => {
            it('passes', async () => {
              const unreadablePath = path.join(
                DEFAULT_CONFIG_ROOT,
                'commands',
                'unreadable.md',
              );
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: unreadablePath,
                content: [
                  '---',
                  'name: unreadable',
                  'description: Unreadable command',
                  '---',
                  '',
                  'Body',
                ].join('\n'),
              });
              mockFailReadFileString({
                handle: mockFileSystem,
                absolutePath: unreadablePath,
                message: 'read failed',
              });
              const { cliOptions } = createTestEnv({ mockFileSystem });

              await expect(
                runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow('read failed');
            });
          });
        });
      });
    });

    describe('Scenario: Surface filesystem errors from writing a target file', () => {
      describe('Given a command output write fails', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the write error is surfaced and no manifest is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'write-fails.md',
                ),
                content: [
                  '---',
                  'name: write-fails',
                  'description: Command that cannot be written',
                  '---',
                  '',
                  'Command body',
                  '',
                ].join('\n'),
              });
              const failingOutputPath = path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'write-fails.prompt.md',
              );
              mockFailWriteFile({
                handle: mockFileSystem,
                absolutePath: failingOutputPath,
                message: 'write target failed',
              });
              const { cliOptions } = createTestEnv({ mockFileSystem });

              await expect(
                runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow('write target failed');

              expect(mockFileSystem.files.has(failingOutputPath)).toBe(false);
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Surface filesystem errors from removing stale manifest outputs', () => {
      describe('Given a stale manifest output cannot be removed', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the remove error is surfaced and the stale output remains', () => {
            it('passes', async () => {
              const staleOutputPath = path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'gone.prompt.md',
              );
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: staleOutputPath,
                content: '# stale\n',
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
                      name: 'gone',
                      outputPath: staleOutputPath,
                    },
                  ],
                }),
              });
              mockFailRemove({
                handle: mockFileSystem,
                absolutePath: staleOutputPath,
                message: 'remove stale output failed',
              });
              const { cliOptions } = createTestEnv({ mockFileSystem });

              await expect(
                runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow('remove stale output failed');

              expect(mockFileSystem.files.has(staleOutputPath)).toBe(true);
            });
          });
        });
      });
    });

    describe('Scenario: Surface write failures while persisting a generated command or rule file', () => {
      describe('Given a generated rule file cannot be written', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the write error is surfaced and no manifest is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'write-error-rule.md',
                ),
                content: [
                  '---',
                  'description: Write error rule',
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
              const failingRulePath = path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'instructions',
                'write-error-rule.instructions.md',
              );
              mockFailWriteFile({
                handle: mockFileSystem,
                absolutePath: failingRulePath,
                message: 'rule write failed',
              });
              const { cliOptions } = createTestEnv({ mockFileSystem });

              await expect(
                runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow('rule write failed');
              expect(mockFileSystem.files.has(failingRulePath)).toBe(false);
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Surface filesystem failures when applying a directory skill target', () => {
      describe('Given applying a directory skill fails while emptying or copying the target', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the underlying filesystem error is surfaced', () => {
            it('passes', async () => {
              for (const scenario of ['emptyDir', 'copy'] as const) {
                mockFileSystem = createMockFileSystemState();
                clearMockFileSystemFailures(mockFileSystem);
                configureMockFileSystem({ handle: mockFileSystem });
                configureMockOs({
                  mockedOs: mockedOs,
                  homeDir: VIRTUAL_HOME_DIR,
                  tmpDir: '/virtual/tmp',
                });
                storeMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    DEFAULT_CONFIG_ROOT,
                    'skills',
                    'error-skill',
                    'SKILL.md',
                  ),
                  content: '# Error skill\n',
                });
                const targetDir = path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'skills',
                  'error-skill',
                );

                if (scenario === 'emptyDir') {
                  mockFailRemove({
                    handle: mockFileSystem,
                    absolutePath: targetDir,
                    message: 'emptyDir failed',
                  });
                } else {
                  mockFailCopyDest({
                    handle: mockFileSystem,
                    destinationPath: path.join(targetDir, 'SKILL.md'),
                    message: 'copy failed',
                  });
                }
                const { cliOptions } = createTestEnv({ mockFileSystem });

                await expect(
                  runCLI({
                    argv: ['sync'],
                    ...cliOptions,
                  }),
                ).rejects.toThrow(
                  scenario === 'emptyDir' ? 'emptyDir failed' : 'copy failed',
                );
              }
            });
          });
        });
      });
    });

    describe('Scenario: Surface ensureDir failures before a write or copy', () => {
      describe('Given a parent directory cannot be created for an output', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the ensureDir error is surfaced and no target file is written', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'ensure-dir-error.md',
                ),
                content: [
                  '---',
                  'name: ensure-dir-error',
                  'description: Ensure dir error',
                  '---',
                  '',
                  'Command body',
                  '',
                ].join('\n'),
              });
              const failingParentDir = path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'skills',
                'ensure-dir-error',
              );
              mockFailMakeDirectory({
                handle: mockFileSystem,
                absolutePath: failingParentDir,
                message: 'ensureDir failed',
              });
              const { cliOptions } = createTestEnv({ mockFileSystem });

              await expect(
                runCLI({
                  argv: ['sync'],
                  ...cliOptions,
                }),
              ).rejects.toThrow('ensureDir failed');
              expect(
                mockFileSystem.files.has(
                  path.join(failingParentDir, 'SKILL.md'),
                ),
              ).toBe(false);
            });
          });
        });
      });
    });

    describe('Scenario: Match the copy layer error when a skill source directory is missing at copy time', () => {
      describe('Given a skill source directory disappears before copy', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the copy layer error is surfaced', () => {
            // priority: low
            it.todo(
              'should match the copy layer error when a skill source directory is missing at copy time',
            );
          });
        });
      });
    });

    describe('Scenario: Surface copy or write failures for symlinked or read-only targets', () => {
      describe('Given an output root target cannot be copied or written', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the copy or write failure is surfaced', () => {
            // priority: low
            it.todo(
              'should surface copy or write failures for symlinked or read-only targets under the output root',
            );
          });
        });
      });
    });

    describe('Scenario: Surface errors when hashing an existing directory target fails', () => {
      describe('Given an existing directory target cannot be hashed', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the hash error is surfaced before deciding whether to copy', () => {
            // priority: low
            it.todo(
              'should surface errors when hashing an existing directory target fails before deciding whether to copy',
            );
          });
        });
      });
    });
  });

  describe('Rule: Empty configs write empty sync state without touching untracked outputs', () => {
    describe('Scenario: Leave outputs unchanged when the config root is empty', () => {
      describe('Given an untracked output exists and there are no sources', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the untracked output is left unchanged', () => {
            it('passes', async () => {
              const untrackedOutput = path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'hand-written.prompt.md',
              );
              const untrackedContent = '# Hand written\n';
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: untrackedOutput,
                content: untrackedContent,
              });
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: untrackedOutput,
                }),
              ).toBe(untrackedContent);
            });
          });
        });
      });
    });

    describe('Scenario: Write no agent outputs when all source roots are empty', () => {
      describe('Given there are no command, rule, or skill sources', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then no agent output files are written', () => {
            it('passes', async () => {
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(
                [...mockFileSystem.files.keys()].filter(
                  (filePath) => !filePath.endsWith('sync-manifest.json'),
                ),
              ).toEqual([]);
            });
          });
        });
      });
    });

    describe('Scenario: Write an empty manifest when all source roots are empty', () => {
      describe('Given there are no command, rule, or skill sources', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then sync-manifest.json has no outputs', () => {
            it('passes', async () => {
              const { cliOptions, stderrMessages } = createTestEnv({
                mockFileSystem,
              });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              expect(readSyncManifest().outputs).toEqual([]);
            });
          });
        });
      });
    });
  });

  describe('Rule: Sync reports describe applied, removed, skipped, and unchanged work consistently', () => {
    describe('Scenario: Group applied items by agent then kind under Applied changes', () => {
      describe('Given basic command, rule, and skill sources exist', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then Applied changes is grouped by agent and kind in registry order', () => {
            it('passes', async () => {
              // Arrange: fresh trio means each item renders once per agent,
              // letting us verify the header, agent ordering, and
              // kind-per-agent grouping without also pinning down the
              // change-type label (covered by the sibling tests below).
              arrangeBasicSources();

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              const report = stripAnsi(stdoutMessages.join(''));

              // Sanity: top-level heading renders and no warnings fired.
              expect(report).toContain('Applied changes:');
              expect(stderrMessages).toEqual([]);

              // Agent sections render in registry definition order
              // (Copilot -> Cursor). Slicing between the two agent headings
              // yields a clean per-agent block.
              const copilotStart = report.indexOf('- Copilot');
              const cursorStart = report.indexOf('- Cursor');
              expect(copilotStart).toBeGreaterThan(-1);
              expect(cursorStart).toBeGreaterThan(copilotStart);

              // Within each agent block, kind headings render in
              // commands -> rules -> skills order, and each item name appears
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

                expect(section.slice(commandsIdx, rulesIdx)).toContain(
                  'my-cmd',
                );
                expect(section.slice(rulesIdx, skillsIdx)).toContain('my-rule');
                expect(section.slice(skillsIdx)).toContain('my-skill');
              }
            });
          });
        });
      });
    });

    describe('Scenario: Tag newly-written items with change-type "(installed)"', () => {
      describe('Given basic sources exist and no outputs exist yet', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each applied item is tagged as installed', () => {
            it('passes', async () => {
              // Arrange: fresh sources, no pre-existing outputs. Every
              // write is a new file, so the report should tag every item
              // `(installed)` (see `changeType` assignment in
              // `src/lib/sync.ts`).
              arrangeBasicSources();

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

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
          });
        });
      });
    });

    describe('Scenario: Tag existing output paths with change-type "(updated)"', () => {
      describe('Given each output path already exists before sync', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each applied item is tagged as updated', () => {
            it('passes', async () => {
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

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

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
          });
        });
      });
    });

    describe('Scenario: Tag pruned items with change-type "(removed)"', () => {
      describe('Given a source is gone but the manifest still lists outputs', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then each stale manifest output is reported as removed', () => {
            it('passes', async () => {
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

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              const report = stripAnsi(stdoutMessages.join(''));

              // Both agents tracked `gone-cmd`, so each agent section
              // should render its own `(removed)` line for it.
              const removedMatches =
                report.match(/gone-cmd \(removed\)/g) ?? [];
              expect(removedMatches).toHaveLength(2);

              expect(stderrMessages).toEqual([]);
            });
          });
        });
      });
    });

    describe('Scenario: Print Skipped conflicts: None when no items were skipped for conflicts', () => {
      describe('Given basic sources exist and there are no conflicts', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report includes the no-conflicts footer', () => {
            it('passes', async () => {
              // Arrange: baseline sources + no pre-existing conflicts
              // means nothing gets skipped. The report should close with
              // the `None` footer branch (see `renderSyncReport` in
              // `src/lib/sync.ts`). Text is asserted after stripAnsi; chalk
              // color (e.g. green for this line) is not under test here.
              arrangeBasicSources();

              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              const report = stripAnsi(stdoutMessages.join(''));

              expect(report).toContain('Skipped conflicts: None');
              expect(stderrMessages).toEqual([]);
            });
          });
        });
      });
    });

    describe('Scenario: Render a coherent report for mixed applied and skipped work', () => {
      describe('Given one command and one skill conflict with each other', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report includes applied changes and skipped conflict details', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'all-skipped-command.md',
                ),
                content: [
                  '---',
                  'name: all-skipped',
                  'description: Command that collides with a skill',
                  '---',
                  '',
                  'Command body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'all-skipped',
                  'SKILL.md',
                ),
                content: '# All skipped skill\n',
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toContain('Applied changes:');
              expect(report).toContain('all-skipped (installed)');
              expect(report).toContain('Skipped conflicts:');
              expect(report).not.toContain('Skipped conflicts: None');
              expect(report).toMatch(
                /command "all-skipped" from .*all-skipped-command\.md/,
              );
              expect(report).toMatch(
                /skill "all-skipped" from .*skills\/all-skipped/,
              );
            });
          });
        });
      });
    });

    describe('Scenario: List only removed lines when the run prunes stale manifest outputs', () => {
      describe('Given the manifest contains stale outputs and no current sources exist', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report lists removed items without installed or updated items', () => {
            it('passes', async () => {
              const copilotOutputPath = path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'gone.prompt.md',
              );
              const cursorOutputDir = path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'skills',
                'gone',
              );
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: copilotOutputPath,
                content: '# stale\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(cursorOutputDir, 'SKILL.md'),
                content: '# stale\n',
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
                      name: 'gone',
                      outputPath: copilotOutputPath,
                    },
                    {
                      agent: 'cursor',
                      kind: 'command',
                      name: 'gone',
                      outputPath: cursorOutputDir,
                    },
                  ],
                }),
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report.match(/gone \(removed\)/g)).toHaveLength(2);
              expect(report).not.toContain('(installed)');
              expect(report).not.toContain('(updated)');
              expect(report).toContain('Skipped conflicts: None');
            });
          });
        });
      });
    });

    describe('Scenario: Keep section spacing stable when one item kind has no output', () => {
      describe('Given command and skill sources exist but no rule sources exist', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report omits the missing kind without extra blank lines', () => {
            it('passes', async () => {
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'partial-command.md',
                ),
                content: [
                  '---',
                  'name: partial-command',
                  'description: Partial command',
                  '---',
                  '',
                  'Command body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'partial-skill',
                  'SKILL.md',
                ),
                content: '# Partial skill\n',
              });
              const { cliOptions, stdoutMessages, stderrMessages } =
                createTestEnv({ mockFileSystem });

              await runCLI({
                argv: ['sync'],
                ...cliOptions,
              });

              expect(stderrMessages).toEqual([]);
              const report = stripAnsi(stdoutMessages.join(''));
              expect(report).toContain(
                'Applied changes:\n\n- Copilot\n  * commands',
              );
              expect(report).toContain('\n  * skills\n');
              expect(report).not.toContain('\n  * rules\n');
              expect(report).not.toContain('\n\n\n');
              expect(report).toContain('\n\nSkipped conflicts: None');
            });
          });
        });
      });
    });

    describe('Scenario: Fail the run when report emission fails', () => {
      describe('Given the logger or string builder throws while emitting the report', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report emission error fails the run', () => {
            // priority: low
            it.todo(
              'should let report emission errors fail the run when the logger or string builder throws',
            );
          });
        });
      });
    });

    describe('Scenario: Keep structural report text free of raw ANSI escape bytes', () => {
      describe('Given styles add color or emphasis to report text', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then structural report text does not include raw ANSI escape bytes', () => {
            // priority: low
            it.todo(
              'should keep structural report text free of raw ANSI escape bytes when styles add color or emphasis',
            );
          });
        });
      });
    });

    describe('Scenario: Omit unchanged items from Applied changes while reporting changed items', () => {
      describe('Given one item is unchanged and another item changes in the same run', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then only changed items appear under Applied changes', () => {
            // priority: low
            it.todo(
              'should omit unchanged items from Applied changes while still reporting changed items in the same run',
            );
          });
        });
      });
    });

    describe('Scenario: Render Skipped conflicts: None when changes apply without conflicts', () => {
      describe('Given applied or removed changes exist and no conflicts exist', () => {
        describe('When I run "dry-ai sync"', () => {
          describe('Then the report includes the no-conflicts footer', () => {
            // priority: low
            it.todo(
              'should render Skipped conflicts: None when there are applied or removed changes but no conflicts',
            );
          });
        });
      });
    });
  });
});
