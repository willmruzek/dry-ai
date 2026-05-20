import os from 'node:os';
import path from 'node:path';

import { defineFeature } from '@amiceli/vitest-cucumber';
import { CommanderError } from 'commander';
import * as Schema from 'effect/Schema';
import { glob } from 'glob';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  type TestEnv,
  deleteMockTextFile,
  mockFailCopyDest,
  mockFailExists,
  mockFailMakeDirectory,
  mockFailReadDirectory,
  mockFailReadFileBytes,
  mockFailReadFileString,
  mockFailRemove,
  mockFailStat,
  mockFailWriteFile,
  normalizeMockPath,
  readMockTextFile,
  removeMockPath,
  storeMockTextFile,
} from '../../helpers.ts';

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
 * Compile-time guard: every `SyncAgent` must be listed when the registry grows so
 * output-tree e2e coverage stays in sync. Invoking this is a no-op at runtime.
 */
function _typesOnlySyncAgentOutputTreeCoverage(
  _: Record<SyncAgent, true>,
): void {}

_typesOnlySyncAgentOutputTreeCoverage({
  copilot: true,
  cursor: true,
});

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

function clearCapturedOutput(
  env: Pick<
    TestEnv,
    | 'cmderStdoutMessages'
    | 'cmderStderrMessages'
    | 'effectStdoutMessages'
    | 'effectStderrMessages'
  >,
): void {
  env.cmderStdoutMessages.length = 0;
  env.cmderStderrMessages.length = 0;
  env.effectStdoutMessages.length = 0;
  env.effectStderrMessages.length = 0;
}

/**
 * Expected per-target `outputPath` for `arrangeBasicSources()` (my-cmd, my-rule, my-skill).
 * Test fixture for the two-agent layout.
 */
/** On-disk `sync-manifest.json` version the CLI is expected to write in these tests. */
const EXPECTED_SYNC_MANIFEST_VERSION = 2 as const;

const TestSyncManifestEntrySchema = Schema.Struct({
  agent: Schema.String,
  kind: Schema.Literal('command', 'rule', 'skill'),
  name: Schema.String.pipe(Schema.minLength(1)),
  outputPath: Schema.String.pipe(Schema.minLength(1)),
});

const TestSyncManifestSchema = Schema.Struct({
  version: Schema.Literal(EXPECTED_SYNC_MANIFEST_VERSION),
  outputs: Schema.Array(TestSyncManifestEntrySchema),
});

const TestSyncManifestJson = Schema.parseJson(TestSyncManifestSchema);
const decodeTestSyncManifestJson =
  Schema.decodeUnknownSync(TestSyncManifestJson);

type TestSyncManifest = typeof TestSyncManifestSchema.Type;

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

function parseTestSyncManifestJson(raw: string): TestSyncManifest {
  return decodeTestSyncManifestJson(raw);
}

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
  const { outputs } = parseTestSyncManifestJson(raw);

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

function arrangeMixedConfigSources(): void {
  for (const commandName of ['alpha-cmd', 'beta-cmd'] as const) {
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
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', skillName, 'SKILL.md'),
      content: `# ${skillName}\n`,
    });
  }
}

function readSyncManifest(): TestSyncManifest {
  return parseTestSyncManifestJson(
    readMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
    }),
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

/**
 * Expected home files after `arrangeBasicSources()` + `dry-ai sync` under the
 * virtual home directory. Alias for readable call sites (`basicWrittenFilePaths`).
 *
 * @see buildExpectedTrioProductFilePaths
 */
const basicWrittenFilePaths =
  buildExpectedTrioProductFilePaths(VIRTUAL_HOME_DIR);

/** Resolved absolute `./output-test` used when passing `--test` without `--output-root`. */
const RESOLVED_TEST_PREVIEW_OUTPUT_ROOT = path.resolve(
  process.cwd(),
  'output-test',
);

describe('dry-ai sync edge coverage', () => {
  beforeEach(() => {
    resetDryAiSyncTestFixtures();
  });

  it('orders manifest entries deterministically', async () => {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'z-command.md'),
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
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'a-command.md'),
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
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', 'z-skill', 'SKILL.md'),
      content: '# Z skill\n',
    });
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', 'a-skill', 'SKILL.md'),
      content: '# A skill\n',
    });

    const env = createTestEnv({ mockFileSystem });
    await runCLI({ argv: ['sync'], ...env.cliOptions });

    expect(env.cmderStderrMessages).toEqual([]);
    expect(env.effectStderrMessages).toEqual([]);

    const manifest = readSyncManifest();
    expect(manifest.outputs).toEqual(
      manifest.outputs.slice().sort(compareManifestEntryTuples),
    );
  });

  it('renders each supported Cursor rule apply mode', async () => {
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

    const env = createTestEnv({ mockFileSystem });
    await runCLI({ argv: ['sync'], ...env.cliOptions });

    expect(env.cmderStderrMessages).toEqual([]);
    expect(env.effectStderrMessages).toEqual([]);
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

  it('generates the expected output matrix for every agent and source kind subset', async () => {
    for (const agent of ['copilot', 'cursor'] as const) {
      resetDryAiSyncTestFixtures();
      arrangeSyncMatrixSources({
        kinds: ['command', 'rule', 'skill'],
        countPerKind: 2,
      });
      const env = createTestEnv({ mockFileSystem });
      await runCLI({ argv: ['sync'], ...env.cliOptions });

      expect(env.cmderStderrMessages).toEqual([]);
      expect(env.effectStderrMessages).toEqual([]);

      expect(collectAgentGeneratedFilePaths(agent)).toEqual(
        buildAgentOutputPaths({
          agent,
          kinds: ['command', 'rule', 'skill'],
          countPerKind: 2,
        }),
      );

      for (const kinds of [
        ['command', 'rule'],
        ['command', 'skill'],
        ['rule', 'skill'],
        ['command'],
        ['rule'],
        ['skill'],
      ] as const) {
        resetDryAiSyncTestFixtures();
        arrangeSyncMatrixSources({ kinds, countPerKind: 1 });
        const env = createTestEnv({ mockFileSystem });
        await runCLI({ argv: ['sync'], ...env.cliOptions });

        expect(env.cmderStderrMessages).toEqual([]);
        expect(env.effectStderrMessages).toEqual([]);

        expect(collectAgentGeneratedFilePaths(agent)).toEqual(
          buildAgentOutputPaths({ agent, kinds, countPerKind: 1 }),
        );
      }
    }
  });

  it('constrains source discovery by kind, extension, and depth', async () => {
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'top-command.md'),
      content: [
        '---',
        'name: top-command',
        'description: Top command',
        '---',
        '',
        'Top command body',
        '',
      ].join('\n'),
    });
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(
        DEFAULT_CONFIG_ROOT,
        'commands',
        'ignored-command.txt',
      ),
      content: 'ignored command',
    });
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(
        DEFAULT_CONFIG_ROOT,
        'rules',
        'nested',
        'nested-rule.md',
      ),
      content: [
        '---',
        'description: Nested rule',
        'agents:',
        '  copilot:',
        "    applyTo: '**'",
        '---',
        '',
        'Nested rule body',
        '',
      ].join('\n'),
    });
    storeMockTextFile({
      handle: mockFileSystem,
      filePath: path.join(DEFAULT_CONFIG_ROOT, 'skills', 'loose-skill.md'),
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

    const env = createTestEnv({ mockFileSystem });
    await runCLI({ argv: ['sync'], ...env.cliOptions });

    expect(env.cmderStderrMessages).toEqual([]);
    expect(env.effectStderrMessages).toEqual([]);

    expect(
      readSyncManifest()
        .outputs.map((entry) => entry.name)
        .sort(),
    ).toEqual(['real-skill', 'real-skill', 'top-command', 'top-command']);
    expect(
      mockFileSystem.files.has(
        path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'prompts',
          'ignored-command.prompt.md',
        ),
      ),
    ).toBe(false);
    expect(
      mockFileSystem.files.has(
        path.join(
          VIRTUAL_HOME_DIR,
          '.copilot',
          'instructions',
          'nested-rule.instructions.md',
        ),
      ),
    ).toBe(false);
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
  });
});

defineFeature('dry-ai sync', (f) => {
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

  f.Rule(
    'Sync workflows keep agent outputs, manifest, and report aligned',
    (r) => {
      r.RuleScenario(
        'Sync a valid config into every supported agent',
        ({ Given, When, Then, And }) => {
          let env: ReturnType<typeof createTestEnv>;

          Given(
            'I have added one command, one rule, and one skill to the config root',
            () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
            },
          );

          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({ argv: ['sync'], ...env.cliOptions });
          });

          Then(
            'dry-ai outputs the expected command, rule, and skill for every supported agent',
            () => {
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);

              for (const filePath of basicWrittenFilePaths) {
                expect(mockFileSystem.files.has(filePath)).toBe(true);
              }
            },
          );

          And(
            'generates command and rule files with expected frontmatter and body',
            () => {
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                }),
              ).toContain('Command body');
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'my-rule.mdc',
                  ),
                }),
              ).toContain('Rule body');
            },
          );

          And('records every managed output in sync-manifest.json', () => {
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          });

          And('installs outputs by agent and kind in the report', () => {
            const report = stripAnsi(env.effectStdoutMessages.join(''));
            expect(report).toContain('my-cmd (installed)');
            expect(report).toContain('my-rule (installed)');
            expect(report).toContain('my-skill (installed)');
          });
        },
      );

      r.RuleScenario(
        'Sync again after changing sources',
        ({ Given, When, And, Then }) => {
          let env: ReturnType<typeof createTestEnv>;

          Given(
            'I have already run `dry-ai sync` for command, rule, and skill outputs',
            async () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
              env = createTestEnv({ mockFileSystem });
              await runCLI({ argv: ['sync'], ...env.cliOptions });
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);
            },
          );

          When('I update command, rule, and skill sources', () => {
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(DEFAULT_CONFIG_ROOT, 'commands', 'my-cmd.md'),
              content: [
                '---',
                'name: my-cmd',
                'description: Test command',
                '---',
                '',
                'Updated command body',
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
                'Updated rule body',
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
              content: '# Updated Skill\n',
            });
            clearCapturedOutput(env);
          });

          And('I run `dry-ai sync` again', async () => {
            await runCLI({ argv: ['sync'], ...env.cliOptions });
          });

          Then(
            'dry-ai updates affected agent outputs from the changed sources',
            () => {
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);

              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'my-cmd.prompt.md',
                  ),
                }),
              ).toContain('Updated command body');
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.cursor',
                    'rules',
                    'my-rule.mdc',
                  ),
                }),
              ).toContain('Updated rule body');
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'skills',
                    'my-skill',
                    'SKILL.md',
                  ),
                }),
              ).toBe('# Updated Skill\n');
            },
          );

          And('keeps sync-manifest.json aligned with managed outputs', () => {
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          });

          And('lists updated outputs in the report', () => {
            const report = stripAnsi(env.effectStdoutMessages.join(''));
            expect(report).toContain('my-cmd (updated)');
            expect(report).toContain('my-rule (updated)');
            expect(report).toContain('my-skill (updated)');
          });
        },
      );

      r.RuleScenario(
        'Sync again after deleting sources',
        ({ Given, When, And, Then }) => {
          let env: ReturnType<typeof createTestEnv>;

          Given(
            'I have already run `dry-ai sync` for command, rule, and skill outputs',
            async () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
              env = createTestEnv({ mockFileSystem });
              await runCLI({ argv: ['sync'], ...env.cliOptions });
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);
            },
          );

          When('I delete a command source and a skill source folder', () => {
            removeMockPath({
              handle: mockFileSystem,
              targetPath: path.join(
                DEFAULT_CONFIG_ROOT,
                'commands',
                'my-cmd.md',
              ),
            });
            removeMockPath({
              handle: mockFileSystem,
              targetPath: path.join(DEFAULT_CONFIG_ROOT, 'skills', 'my-skill'),
            });
            clearCapturedOutput(env);
          });

          And('I run `dry-ai sync` again', async () => {
            await runCLI({ argv: ['sync'], ...env.cliOptions });
          });

          Then('dry-ai removes managed outputs for deleted sources', () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(
              mockFileSystem.files.has(getBasicCommandOutputPath('copilot')),
            ).toBe(false);
            expect(
              mockFileSystem.files.has(getBasicCommandOutputPath('cursor')),
            ).toBe(false);
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'skills',
                  'my-skill',
                  'SKILL.md',
                ),
              ),
            ).toBe(false);
          });

          And('keeps unrelated outputs managed', () => {
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  'my-rule.instructions.md',
                ),
              ),
            ).toBe(true);
          });

          And('removes deleted sources from sync-manifest.json', () => {
            expect(
              readSyncManifest().outputs.some(
                (entry) => entry.name === 'my-cmd' || entry.name === 'my-skill',
              ),
            ).toBe(false);
          });

          And('lists removed outputs in the report', () => {
            const report = stripAnsi(env.effectStdoutMessages.join(''));
            expect(report).toContain('my-cmd (removed)');
            expect(report).toContain('my-skill (removed)');
          });
        },
      );

      r.RuleScenario(
        'Sync repairs generated files changed by hand',
        ({ Given, When, And, Then }) => {
          let env: ReturnType<typeof createTestEnv>;

          Given(
            'I have already run `dry-ai sync` for command, rule, and skill outputs',
            async () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
              env = createTestEnv({ mockFileSystem });
              await runCLI({ argv: ['sync'], ...env.cliOptions });
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);
            },
          );

          When('I edit generated agent files directly', () => {
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'my-cmd.prompt.md',
              ),
              content: '# Drifted command\n',
            });
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'rules',
                'my-rule.mdc',
              ),
              content: '# Drifted rule\n',
            });
            clearCapturedOutput(env);
          });

          And('I run `dry-ai sync` again', async () => {
            await runCLI({ argv: ['sync'], ...env.cliOptions });
          });

          Then('dry-ai restores generated files from source', () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'my-cmd.prompt.md',
                ),
              }),
            ).toContain('Command body');
            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'my-rule.mdc',
                ),
              }),
            ).toContain('Rule body');
          });

          And('keeps sync-manifest.json aligned with managed outputs', () => {
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          });

          And('lists repaired outputs in the report', () => {
            const report = stripAnsi(env.effectStdoutMessages.join(''));
            expect(report).toContain('my-cmd (updated)');
            expect(report).toContain('my-rule (updated)');
          });
        },
      );

      r.RuleScenario(
        'Reinstall managed outputs removed from disk while sources stay the same',
        ({ Given, When, And, Then }) => {
          let env: ReturnType<typeof createTestEnv>;

          Given(
            'I have already run `dry-ai sync` for command, rule, and skill outputs',
            async () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
              env = createTestEnv({ mockFileSystem });
              await runCLI({ argv: ['sync'], ...env.cliOptions });
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);
            },
          );

          When(
            'I delete a managed Copilot command output file while leaving config sources unchanged',
            () => {
              deleteMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'my-cmd.prompt.md',
                ),
              });
              clearCapturedOutput(env);
            },
          );

          And('I run `dry-ai sync` again', async () => {
            await runCLI({ argv: ['sync'], ...env.cliOptions });
          });

          Then('dry-ai restores that output from the unchanged source', () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'my-cmd.prompt.md',
                ),
              }),
            ).toContain('Command body');
            const report = stripAnsi(env.effectStdoutMessages.join(''));
            expect(report).toContain('my-cmd (installed)');
          });

          And('keeps sync-manifest.json aligned with managed outputs', () => {
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          });
        },
      );

      r.RuleScenario(
        'Discover only markdown files directly under commands and rules',
        ({ Given, When, Then, And }) => {
          Given(
            'I have top-level and nested markdown under commands and rules plus one valid skill',
            () => {
              resetDryAiSyncTestFixtures();
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'top-command.md',
                ),
                content: [
                  '---',
                  'name: top-command',
                  'description: Top command',
                  '---',
                  '',
                  'Top command body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'nested',
                  'nested-command.md',
                ),
                content: [
                  '---',
                  'name: nested-command',
                  'description: Nested command',
                  '---',
                  '',
                  'Nested command body',
                  '',
                ].join('\n'),
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'top-rule.md',
                ),
                content: [
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
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'rules',
                  'nested',
                  'nested-rule.md',
                ),
                content: [
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
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'only-skill',
                  'SKILL.md',
                ),
                content: '# Only skill\n',
              });
            },
          );

          When('I run `dry-ai sync`', async () => {
            const env = createTestEnv({
              mockFileSystem,
            });
            await runCLI({ argv: ['sync'], ...env.cliOptions });

            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);
          });

          Then(
            'dry-ai ignores nested command and rule markdown discovered only via depth',
            () => {
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'nested-command.prompt.md',
                  ),
                ),
              ).toBe(false);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'nested-rule.instructions.md',
                  ),
                ),
              ).toBe(false);

              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'prompts',
                    'top-command.prompt.md',
                  ),
                ),
              ).toBe(true);
              expect(
                mockFileSystem.files.has(
                  path.join(
                    VIRTUAL_HOME_DIR,
                    '.copilot',
                    'instructions',
                    'top-rule.instructions.md',
                  ),
                ),
              ).toBe(true);
            },
          );

          And(
            'records only top-level commands and rules in sync-manifest.json',
            () => {
              const names = readSyncManifest()
                .outputs.map((o) => o.name)
                .sort();
              expect(names).toEqual([
                'only-skill',
                'only-skill',
                'top-command',
                'top-command',
                'top-rule',
                'top-rule',
              ]);
            },
          );
        },
      );

      r.RuleScenario(
        'Sync skips invalid frontmatter without blocking valid sources',
        ({ Given, When, Then, And }) => {
          let env: ReturnType<typeof createTestEnv>;

          Given(
            'I have added valid sources and sources with invalid frontmatter to the config root',
            () => {
              resetDryAiSyncTestFixtures();
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
            },
          );

          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({ argv: ['sync'], ...env.cliOptions });
          });

          Then('dry-ai writes the valid outputs', () => {
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
          });

          And('skips invalid outputs with warnings', () => {
            expect(stripAnsi(env.effectStdoutMessages.join(''))).toMatch(
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

          And('records only written outputs in sync-manifest.json', () => {
            expect(
              readSyncManifest().outputs.every(
                (entry) => entry.name === 'valid-command',
              ),
            ).toBe(true);
          });
        },
      );

      r.RuleScenario(
        'Sync with custom roots writes to the requested locations',
        ({ Given, When, Then, And }) => {
          let env: ReturnType<typeof createTestEnv>;
          const outputRoot = '/virtual/output-root';

          Given(
            'I have added one command, one rule, and one skill to the config root',
            () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
            },
          );

          When(
            'I run `dry-ai sync` with custom config and output roots',
            async () => {
              env = createTestEnv({ mockFileSystem });
              await runCLI({
                argv: ['--output-root', outputRoot, 'sync'],
                ...env.cliOptions,
              });
            },
          );

          Then(
            'dry-ai writes agent outputs under the requested output root',
            () => {
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);
              for (const filePath of buildExpectedTrioProductFilePaths(
                outputRoot,
              )) {
                expect(mockFileSystem.files.has(filePath)).toBe(true);
              }
            },
          );

          And(
            'writes sync-manifest.json beside the requested config root',
            () => {
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(true);
            },
          );

          And('shows the resolved output root in the report', () => {
            expect(stripAnsi(env.effectStdoutMessages.join(''))).toContain(
              outputRoot,
            );
          });
        },
      );
    },
  );

  f.Rule('Valid frontmatter controls rendered outputs', (r) => {
    r.RuleScenario(
      'Omit unresolved optional frontmatter keys',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have command and rule sources with unresolved optional frontmatter',
          () => {
            resetDryAiSyncTestFixtures();
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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai omits optional frontmatter keys with nothing to render from the written file',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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

            expect(cursorCommand).not.toContain('disable-model-invocation:');
            expect(cursorRule).not.toContain('globs:');
            expect(cursorRule).toContain('alwaysApply: true');
          },
        );
      },
    );
    r.RuleScenario(
      'Keep body whitespace normalization consistent across output types',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have command and rule sources with padded body whitespace',
          () => {
            resetDryAiSyncTestFixtures();
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
              filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', 'body-rule.md'),
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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai trims leading and trailing body whitespace the same way for commands, rules, and skills before writing',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            const expectedCommandBody =
              'First command line.  \n  Second command line.';
            const expectedRuleBody = 'First rule line.  \n  Second rule line.';

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
              path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules', 'body-rule.mdc'),
            ]) {
              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: outputPath,
                }),
              ).toContain(expectedRuleBody);
            }
          },
        );
      },
    );
    r.RuleScenario(
      'Write command and rule outputs with only top-level metadata when agents is omitted',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given('I have command and rule sources without an `agents` map', () => {
          resetDryAiSyncTestFixtures();
          storeMockTextFile({
            handle: mockFileSystem,
            filePath: path.join(
              DEFAULT_CONFIG_ROOT,
              'commands',
              'default-command.md',
            ),
            content: [
              '---',
              'name: default-command',
              'description: Default command',
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
        });
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai renders commands and rules from shared top-level frontmatter',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            const copilotCommand = readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'prompts',
                'default-command.prompt.md',
              ),
            });
            expect(copilotCommand).toContain('name: default-command');
            expect(copilotCommand).toContain('description: Default command');

            const cursorCommand = readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                VIRTUAL_HOME_DIR,
                '.cursor',
                'skills',
                'default-command',
                'SKILL.md',
              ),
            });
            expect(cursorCommand).toContain('name: default-command');
            expect(cursorCommand).toContain('description: Default command');

            for (const commandOutput of [copilotCommand, cursorCommand]) {
              expect(commandOutput).not.toContain('disable-model-invocation:');
              expect(commandOutput).not.toContain('agents:');
            }

            const copilotRule = readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                VIRTUAL_HOME_DIR,
                '.copilot',
                'instructions',
                'copilot-default-rule.instructions.md',
              ),
            });
            expect(copilotRule).toContain('description: Copilot default rule');
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
          },
        );
      },
    );
  });

  f.Rule('Skill targets mirror source trees', (r) => {
    r.RuleScenario(
      'Mirror the complete skill source tree into each agent target',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given('I have a skill source tree with nested files', () => {
          resetDryAiSyncTestFixtures();
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
        });
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });
          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai copies nested folders and extra files inside each skill into both agent skill targets',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            const skillName = 'tree-skill';
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
          },
        );
      },
    );
    r.RuleScenario(
      'Remove deleted source files from copied skill targets on the next sync',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have synced a skill source tree with a file that is later deleted',
          async () => {
            resetDryAiSyncTestFixtures();
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

            const env = createTestEnv({
              mockFileSystem,
            });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            });
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai removes vanished source skill files from both mirrored skill trees on the next sync',
          () => {
            const skillName = 'prune-skill';
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
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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
          },
        );
      },
    );
  });
  f.Rule('Sync manifest tracks managed artifact state', (r) => {
    r.RuleScenario(
      'Write mixed config manifest rows without dropping or merging kinds',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given('I have mixed command, rule, and skill sources', () => {
          resetDryAiSyncTestFixtures();
          arrangeMixedConfigSources();
        });
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai lists commands, rules, and skills as distinct sync-manifest.json rows without dropping kinds',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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
          },
        );
      },
    );
    r.RuleScenario(
      'Recover when sync-manifest.json is not valid JSON',
      ({ Given, When, Then, And }) => {
        let stderrCapture: string[] = [];

        Given(
          'I have the basic trio under the config root and sync-manifest.json contains invalid JSON',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
              content: '{ damaged manifest',
            });
          },
        );
        When('I run `dry-ai sync`', async () => {
          const env = createTestEnv({
            mockFileSystem,
          });
          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
          stderrCapture = env.effectStderrMessages;
        });
        Then(
          'dry-ai warns that sync-manifest.json is damaged or incomplete',
          () => {
            expect(stderrCapture.join('\n')).toContain(
              'sync-manifest.json is damaged or incomplete',
            );
          },
        );
        And(
          'replaces sync-manifest.json with rows for the current trio outputs',
          () => {
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          },
        );
      },
    );
    r.RuleScenario(
      'Recover when sync-manifest.json cannot be read',
      ({ Given, When, Then, And }) => {
        let stderrCapture: string[] = [];
        const manifestPath = path.join(
          DEFAULT_CONFIG_ROOT,
          'sync-manifest.json',
        );

        Given(
          'I have the basic trio and sync-manifest.json is unreadable by the filesystem mock',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: manifestPath,
              content: '{"version":2,"outputs":[]}',
            });
            mockFailReadFileString({
              handle: mockFileSystem,
              absolutePath: manifestPath,
              message: 'permission denied',
            });
          },
        );
        When('I run `dry-ai sync`', async () => {
          const env = createTestEnv({
            mockFileSystem,
          });
          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
          stderrCapture = env.effectStderrMessages;
        });
        Then('dry-ai warns that sync-manifest.json could not be read', () => {
          expect(stderrCapture.join('\n')).toContain(
            'Could not read sync-manifest.json',
          );
        });
        And(
          'replaces sync-manifest.json with rows for the current trio outputs',
          () => {
            clearMockFileSystemFailures(mockFileSystem);
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          },
        );
      },
    );
    r.RuleScenario(
      'Rebuild sync-manifest.json when the on-disk manifest version is older than the tool expects',
      ({ Given, When, Then, And }) => {
        let stderrCapture: string[] = [];

        Given(
          'I have the basic trio and sync-manifest.json declares an outdated manifest schema version',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
              content: JSON.stringify({ version: 1, outputs: [] }),
            });
          },
        );
        When('I run `dry-ai sync`', async () => {
          const env = createTestEnv({
            mockFileSystem,
          });
          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
          stderrCapture = env.effectStderrMessages;
        });
        Then(
          'dry-ai warns that sync-manifest.json did not match the expected layout',
          () => {
            expect(stderrCapture.join('\n')).toContain(
              'sync-manifest.json did not match the expected layout',
            );
          },
        );
        And(
          'writes sync-manifest.json using the current schema version and trio outputs',
          () => {
            const raw = readMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
            });
            const parsed = parseTestSyncManifestJson(raw);
            expect(parsed.version).toBe(EXPECTED_SYNC_MANIFEST_VERSION);
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              VIRTUAL_HOME_DIR,
            );
          },
        );
      },
    );
  });
  f.Rule('Aligned sync state is a no-op', (r) => {
    r.RuleScenario(
      'Report no applied changes when sync state stays aligned',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have already synced the basic trio once so outputs match sources',
          async () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
            const setupEnv = createTestEnv({
              mockFileSystem,
            });
            await runCLI({
              argv: ['sync'],
              ...setupEnv.cliOptions,
            });
            expect(setupEnv.cmderStderrMessages).toEqual([]);
            expect(setupEnv.effectStderrMessages).toEqual([]);
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          clearCapturedOutput(env);

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai reports that nothing needs applying on a second sync against an already-aligned tree',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            const report = stripAnsi(env.effectStdoutMessages.join(''));
            expect(report).toContain('Applied changes: None');
            expect(report).not.toContain('- Copilot');
          },
        );
      },
    );
  });
  f.Rule('Ownership conflicts skip only conflicting artifacts', (r) => {
    r.RuleScenario(
      'Write manifest rows and report text only for non-conflicting outputs',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have a command and skill that share the same Cursor-facing name',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeCursorSkillNameConflict();
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai mentions only written paths in the manifest and report, not paths skipped for conflicts',
          () => {
            expect(env.cmderStdoutMessages).toEqual([]);
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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

            const report = stripAnsi(env.effectStdoutMessages.join(''));
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
          },
        );
      },
    );
    r.RuleScenario(
      'Sync rule and skill sources that share the same basename without ownership conflicts',
      ({ Given, When, Then, And }) => {
        const base = 'same-base';
        let reportText = '';

        Given(
          'I have a rule and a skill whose rule stem and skill folder share the same basename',
          () => {
            resetDryAiSyncTestFixtures();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(DEFAULT_CONFIG_ROOT, 'rules', `${base}.md`),
              content: [
                '---',
                `description: ${base} rule`,
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
                base,
                'SKILL.md',
              ),
              content: `# ${base} skill\n`,
            });
          },
        );
        When('I run `dry-ai sync`', async () => {
          const env = createTestEnv({
            mockFileSystem,
          });
          await runCLI({ argv: ['sync'], ...env.cliOptions });

          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);

          reportText = stripAnsi(env.effectStdoutMessages.join(''));
        });
        Then(
          'dry-ai writes both rule and skill outputs for every supported agent',
          () => {
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  `${base}.instructions.md`,
                ),
              ),
            ).toBe(true);
            expect(
              mockFileSystem.files.has(
                path.join(VIRTUAL_HOME_DIR, '.cursor', 'rules', `${base}.mdc`),
              ),
            ).toBe(true);
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'skills',
                  base,
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
                  base,
                  'SKILL.md',
                ),
              ),
            ).toBe(true);
          },
        );
        And('reports no skipped ownership conflicts', () => {
          expect(reportText).toContain('Skipped conflicts:');
          expect(reportText).toContain('Skipped conflicts: None');
        });
      },
    );
    r.RuleScenario(
      'Sync rule and command sources that share the same logical name without ownership conflicts',
      ({ Given, When, Then, And }) => {
        const sharedName = 'shared-logical';
        let reportText = '';

        Given(
          'I have a rule stem and command name that match and no skill reuses that Cursor skill directory',
          () => {
            resetDryAiSyncTestFixtures();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                DEFAULT_CONFIG_ROOT,
                'commands',
                'other-cmd.md',
              ),
              content: [
                '---',
                `name: ${sharedName}`,
                `description: ${sharedName} command`,
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
                `${sharedName}.md`,
              ),
              content: [
                '---',
                `description: ${sharedName} rule`,
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
                'aux-skill',
                'SKILL.md',
              ),
              content: '# aux skill\n',
            });
          },
        );
        When('I run `dry-ai sync`', async () => {
          const env = createTestEnv({
            mockFileSystem,
          });
          await runCLI({ argv: ['sync'], ...env.cliOptions });

          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);

          reportText = stripAnsi(env.effectStdoutMessages.join(''));
        });
        Then(
          'dry-ai writes both rule and command outputs for every supported agent',
          () => {
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'prompts',
                  'other-cmd.prompt.md',
                ),
              ),
            ).toBe(true);
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'skills',
                  sharedName,
                  'SKILL.md',
                ),
              ),
            ).toBe(true);
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.copilot',
                  'instructions',
                  `${sharedName}.instructions.md`,
                ),
              ),
            ).toBe(true);
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  `${sharedName}.mdc`,
                ),
              ),
            ).toBe(true);
          },
        );
        And('reports no skipped ownership conflicts', () => {
          expect(reportText).toContain('Skipped conflicts:');
          expect(reportText).toContain('Skipped conflicts: None');
        });
      },
    );
  });
  f.Rule('Invalid frontmatter controls skipped outputs', (r) => {
    r.RuleScenario(
      'Write valid command output when another agent block is invalid',
      ({ Given, When, Then }) => {
        let results: {
          expectedSkipPattern: RegExp;
          env: TestEnv;
          outcomes: {
            validWritten: boolean;
            validBody: string;
            invalidWritten: boolean;
          };
        }[] = [];

        Given(
          'I reset the workspace before syncing commands with one valid and one invalid agent block each',
          () => {
            resetDryAiSyncTestFixtures();
          },
        );
        When('I run `dry-ai sync`', async () => {
          results = [];
          for (const __row of [
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
          ] as const) {
            const {
              fileStem,
              invalidOutputPath,
              sourceLines,
              validAgent,
              validOutputPath,
            } = __row;
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

            const env = createTestEnv({ mockFileSystem });

            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            });

            const skipAgent = validAgent === 'Copilot' ? 'Cursor' : 'Copilot';
            const expectedSkipPattern = new RegExp(
              `Skipping ${skipAgent} for .*${fileStem}\\.md`,
              's',
            );

            results.push({
              expectedSkipPattern,
              env,
              outcomes: {
                validWritten: mockFileSystem.files.has(validOutputPath),
                validBody: mockFileSystem.files.has(validOutputPath)
                  ? readMockTextFile({
                      handle: mockFileSystem,
                      filePath: validOutputPath,
                    })
                  : '',
                invalidWritten: mockFileSystem.files.has(invalidOutputPath),
              },
            });
          }
        });
        Then(
          'dry-ai still writes the healthy agent command and skips the invalid block with a useful warning',
          () => {
            for (const r of results) {
              expect(r.outcomes.validWritten).toBe(true);
              expect(r.outcomes.validBody).toContain('Command body');
              expect(r.outcomes.invalidWritten).toBe(false);
              expect(r.env.cmderStdoutMessages).toEqual([]);
              expect(r.env.cmderStderrMessages).toEqual([]);
              expect(stripAnsi(r.env.effectStderrMessages.join(''))).toMatch(
                r.expectedSkipPattern,
              );
            }
          },
        );
      },
    );
    r.RuleScenario(
      'Skip a rule when top-level frontmatter fails validation',
      ({ Given, When, Then, And }) => {
        let env: TestEnv;

        Given(
          'I have one invalid rule and one valid command in the config root',
          () => {
            resetDryAiSyncTestFixtures();
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
                '  cursor:',
                "    globs: '**'",
                '---',
                '',
                'Invalid rule body',
                '',
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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai skips the broken rule without leaving partial Copilot or Cursor rule files',
          () => {
            expect(env.cmderStdoutMessages).toEqual([]);
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(stripAnsi(env.effectStdoutMessages.join(''))).toMatch(
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
            expect(
              mockFileSystem.files.has(
                path.join(
                  VIRTUAL_HOME_DIR,
                  '.cursor',
                  'rules',
                  'invalid-rule.mdc',
                ),
              ),
            ).toBe(false);
          },
        );
        And('still writes the valid command outputs', () => {
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
                '.cursor',
                'skills',
                'valid-command',
                'SKILL.md',
              ),
            ),
          ).toBe(true);
        });
      },
    );
    r.RuleScenario(
      'Keep syncing after one command or rule is skipped for invalid frontmatter',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have one invalid command and one valid command in the config root',
          () => {
            resetDryAiSyncTestFixtures();
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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai still syncs later valid sources cleanly after it skips an earlier command or rule',
          () => {
            expect(env.cmderStdoutMessages).toEqual([]);
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(stripAnsi(env.effectStdoutMessages.join(''))).toMatch(
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
          },
        );
      },
    );
    r.RuleScenario(
      'Skip a command agent output when its per-agent block fails validation',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have a command with a valid Copilot block and an invalid Cursor block',
          () => {
            resetDryAiSyncTestFixtures();
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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai skips only the failing per-agent slice while other agents continue to receive output',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(stripAnsi(env.effectStderrMessages.join(''))).toMatch(
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
          },
        );
      },
    );
    r.RuleScenario(
      'Warn and skip without partial outputs when frontmatter parses but validation fails',
      ({ Given, When, Then }) => {
        let env: TestEnv;

        Given(
          'I have a command whose top-level frontmatter is missing a required description',
          () => {
            resetDryAiSyncTestFixtures();
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
          },
        );
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai warns, skips the invalid file, and avoids half-written outputs',
          () => {
            expect(env.cmderStdoutMessages).toEqual([]);
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(stripAnsi(env.effectStdoutMessages.join(''))).toMatch(
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
            const manifest = parseTestSyncManifestJson(
              readMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
              }),
            );
            expect(manifest.outputs).toEqual([]);
          },
        );
      },
    );
  });
  f.Rule('CLI roots determine source, output, and manifest locations', (r) => {
    r.RuleScenario(
      'Read sources from an absolute config root while using the default output tree',
      ({ Given, When, Then }) => {
        const configRoot = '/virtual/custom-config';
        let env: TestEnv;

        Given(
          'I have a command under an absolute config root outside the default path',
          () => {
            resetDryAiSyncTestFixtures();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(configRoot, 'commands', 'custom-command.md'),
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
          },
        );
        When(
          'I run `dry-ai --config-root /virtual/custom-config sync`',
          async () => {
            env = createTestEnv({
              mockFileSystem,
            });

            await runCLI({
              argv: ['--config-root', configRoot, 'sync'],
              ...env.cliOptions,
            });
          },
        );
        Then(
          'dry-ai still writes into the default home-relative layout when I pass an absolute `--config-root` without overriding outputs',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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
          },
        );
      },
    );
    r.RuleScenario(
      'Prefer --output-root when --test is also passed',
      ({ Given, When, Then }) => {
        const outputRoot = '/virtual/explicit-output';
        let env: TestEnv;

        Given(
          'I have the usual command, rule, and skill under the default config root',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
          },
        );
        When(
          'I run `dry-ai sync` with --test and an explicit output root',
          async () => {
            env = createTestEnv({ mockFileSystem });

            await runCLI({
              argv: ['--test', '--output-root', outputRoot, 'sync'],
              ...env.cliOptions,
            });
          },
        );
        Then(
          'dry-ai prefers an explicit `--output-root` over the preview path implied by `--test`',
          () => {
            expect(env.cmderStdoutMessages).toEqual([]);
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

            expect(stripAnsi(env.effectStdoutMessages.join(''))).toContain(
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
                  RESOLVED_TEST_PREVIEW_OUTPUT_ROOT,
                  '.copilot',
                  'prompts',
                  'my-cmd.prompt.md',
                ),
              ),
            ).toBe(false);
          },
        );
      },
    );
    r.RuleScenario(
      'Write outputs under the test preview tree when only --test is passed',
      ({ Given, When, Then, And }) => {
        let stdoutJoined = '';

        Given(
          'I have the usual command, rule, and skill under the default config root',
          () => {
            resetDryAiSyncTestFixtures();
            arrangeBasicSources();
          },
        );
        When('I run `dry-ai sync` with only --test', async () => {
          const env = createTestEnv({
            mockFileSystem,
          });

          await runCLI({
            argv: ['--test', 'sync'],
            ...env.cliOptions,
          });

          expect(env.cmderStdoutMessages).toEqual([]);
          expect(env.cmderStderrMessages).toEqual([]);
          expect(env.effectStderrMessages).toEqual([]);

          stdoutJoined = stripAnsi(env.effectStdoutMessages.join(''));
        });
        Then(
          'dry-ai writes agent outputs under the resolved test preview directory',
          () => {
            for (const filePath of buildExpectedTrioProductFilePaths(
              RESOLVED_TEST_PREVIEW_OUTPUT_ROOT,
            )) {
              expect(mockFileSystem.files.has(filePath)).toBe(true);
            }
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
            assertMockSyncManifestMatchesTrio(
              mockFileSystem,
              DEFAULT_CONFIG_ROOT,
              RESOLVED_TEST_PREVIEW_OUTPUT_ROOT,
            );
          },
        );
        And('logs the resolved output root after a successful sync', () => {
          expect(stdoutJoined).toContain(
            `Generated output written to ${RESOLVED_TEST_PREVIEW_OUTPUT_ROOT}`,
          );
        });
      },
    );
    r.RuleScenario(
      'Keep --config-root from changing the output root',
      ({ Given, When, Then }) => {
        const configRoot = '/virtual/config-only-root';
        let env: TestEnv;

        Given(
          'I have a command only under an alternate absolute config root',
          () => {
            resetDryAiSyncTestFixtures();
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
          },
        );
        When(
          'I run `dry-ai --config-root /virtual/config-only-root sync`',
          async () => {
            env = createTestEnv({
              mockFileSystem,
            });

            await runCLI({
              argv: ['--config-root', configRoot, 'sync'],
              ...env.cliOptions,
            });
          },
        );
        Then(
          'dry-ai does not silently redirect agent outputs when I pass only `--config-root`',
          () => {
            expect(env.cmderStderrMessages).toEqual([]);
            expect(env.effectStderrMessages).toEqual([]);

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
          },
        );
      },
    );
    r.RuleScenario(
      'Reject an unsupported CLI flag',
      ({ Given, When, Then }) => {
        let env: TestEnv;
        let error: CommanderError;

        Given('I pass only invalid CLI options before sync', () => {
          resetDryAiSyncTestFixtures();
        });
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          error = await runCLIExpectingError({
            argv: ['--bogus', 'sync'],
            ...env.cliOptions,
          });
        });
        Then(
          'dry-ai stops the run with a clear error for an unknown flag',
          () => {
            expect(error).toBeInstanceOf(CommanderError);
            expect(error.code).toBe('commander.unknownOption');
            expect(error.exitCode).toBe(1);
            expect(env.cmderStdoutMessages).toEqual([]);
            expect(env.cmderStderrMessages.join('')).toContain(
              "unknown option '--bogus'",
            );
          },
        );
      },
    );
    r.RuleScenario(
      'Reject a missing config root path',
      ({ Given, When, Then }) => {
        const missingConfigRoot = '/virtual/missing-config-root';
        let env: TestEnv;

        Given('I point --config-root at a path that does not exist', () => {
          resetDryAiSyncTestFixtures();
        });
        When('I run `dry-ai sync`', async () => {
          env = createTestEnv({
            mockFileSystem,
          });

          await expect(
            runCLI({
              argv: ['--config-root', missingConfigRoot, 'sync'],
              ...env.cliOptions,
            }),
          ).rejects.toThrow(`Config root does not exist: ${missingConfigRoot}`);
        });
        Then(
          'dry-ai fails fast with a clear error for a missing configuration directory',
          () => {
            expect(
              mockFileSystem.files.has(
                path.join(missingConfigRoot, 'sync-manifest.json'),
              ),
            ).toBe(false);
          },
        );
      },
    );
  });
  f.Rule(
    'Registry and manifest metadata are validated before sync work proceeds',
    (r) => {
      r.RuleScenario(
        'Fail when the manifest names an agent that no longer exists',
        ({ Given, When, Then }) => {
          const staleOutputPath = path.join(
            VIRTUAL_HOME_DIR,
            '.retired-agent',
            'commands',
            'old.md',
          );
          Given(
            'sync-manifest.json references a retired agent and a matching output file on disk',
            () => {
              resetDryAiSyncTestFixtures();
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: staleOutputPath,
                content: '# old output\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                content: JSON.stringify({
                  version: EXPECTED_SYNC_MANIFEST_VERSION,
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
            },
          );
          When('I run `dry-ai sync`', async () => {
            const env = createTestEnv({
              mockFileSystem,
            });

            await expect(
              runCLI({
                argv: ['sync'],
                ...env.cliOptions,
              }),
            ).rejects.toThrow(
              /sync-manifest\.json references unregistered agent "retired-agent"\. Remove entries for "retired-agent" from sync-manifest\.json, or delete sync-manifest\.json to rebuild it on the next sync\./,
            );
          });
          Then(
            'dry-ai exits before doing work when the manifest names an unregistered agent',
            () => {
              expect(mockFileSystem.files.has(staleOutputPath)).toBe(true);
            },
          );
        },
      );
    },
  );
  f.Rule(
    'Filesystem failures fail the run without silent partial success',
    (r) => {
      r.RuleScenario(
        'Surface ensureDir failures when ensuring agent target roots',
        ({ Given, When, Then }) => {
          const failingTargetRoot = normalizeMockPath(
            path.join(VIRTUAL_HOME_DIR, '.copilot', 'prompts'),
          );
          let env: TestEnv;
          Given(
            'agent output roots are set up so creating the Copilot prompts tree fails',
            () => {
              resetDryAiSyncTestFixtures();
              mockFailMakeDirectory({
                handle: mockFileSystem,
                absolutePath: failingTargetRoot,
                message: 'mkdir target root failed (test)',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then(
            'dry-ai fails before manifest IO with a directory creation error for that target root',
            () => {
              expect(env.effectStderrMessages).toEqual([
                `Could not create directory: ${failingTargetRoot}\n`,
              ]);
            },
          );
        },
      );
      r.RuleScenario(
        'Surface path-exists check failures while probing sync-manifest.json',
        ({ Given, When, Then }) => {
          const manifestPath = normalizeMockPath(
            path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
          );
          let env: TestEnv;
          Given(
            'the mock filesystem refuses path-exists checks for the manifest file',
            () => {
              resetDryAiSyncTestFixtures();
              mockFailExists({
                handle: mockFileSystem,
                absolutePath: manifestPath,
                message: 'exists check failed (test)',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then(
            'dry-ai fails while checking whether the manifest path exists',
            () => {
              expect(env.effectStderrMessages).toEqual([
                `Could not check whether path exists: ${manifestPath}\n`,
              ]);
            },
          );
        },
      );
      r.RuleScenario(
        'Surface readDirectory failures while listing local skills',
        ({ Given, When, Then }) => {
          const skillsRoot = normalizeMockPath(
            path.join(DEFAULT_CONFIG_ROOT, 'skills'),
          );
          let env: TestEnv;
          Given('the skills directory cannot be listed (simulated)', () => {
            resetDryAiSyncTestFixtures();
            mockFailReadDirectory({
              handle: mockFileSystem,
              absolutePath: skillsRoot,
              message: 'read skills dir failed (test)',
            });
          });
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then('dry-ai fails while reading the skills directory', () => {
            expect(env.effectStderrMessages).toEqual([
              `Could not read directory: ${skillsRoot}\n`,
            ]);
          });
        },
      );
      r.RuleScenario(
        'Surface stat failures while classifying a skill folder entry',
        ({ Given, When, Then }) => {
          const statEntryPath = normalizeMockPath(
            path.join(DEFAULT_CONFIG_ROOT, 'skills', 'stat-fail'),
          );
          let env: TestEnv;
          Given('a skill folder entry cannot be stat-d (simulated)', () => {
            resetDryAiSyncTestFixtures();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                DEFAULT_CONFIG_ROOT,
                'skills',
                'stat-fail',
                'SKILL.md',
              ),
              content: '# Stat fail skill\n',
            });
            mockFailStat({
              handle: mockFileSystem,
              absolutePath: statEntryPath,
              message: 'stat failed (test)',
            });
          });
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then('dry-ai fails while inspecting that path during sync', () => {
            expect(env.effectStderrMessages).toEqual([
              `Could not inspect path while syncing: ${statEntryPath}\n`,
            ]);
          });
        },
      );
      r.RuleScenario(
        'Surface skill directory walk failures while hashing source files',
        ({ Given, When, Then }) => {
          const nestedDir = normalizeMockPath(
            path.join(DEFAULT_CONFIG_ROOT, 'skills', 'walk-fail', 'nested'),
          );
          let env: TestEnv;
          Given(
            'a nested path under a skill refuses readDirectory during the walk',
            () => {
              resetDryAiSyncTestFixtures();
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'walk-fail',
                  'SKILL.md',
                ),
                content: '# Walk fail\n',
              });
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'walk-fail',
                  'nested',
                  'extra.md',
                ),
                content: 'x\n',
              });
              mockFailReadDirectory({
                handle: mockFileSystem,
                absolutePath: nestedDir,
                message: 'walk read dir failed (test)',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then('dry-ai fails while scanning the skill directory tree', () => {
            expect(env.effectStderrMessages).toEqual([
              `Could not scan skill directory: ${nestedDir}\n`,
            ]);
          });
        },
      );
      r.RuleScenario(
        'Surface read errors for discovered files',
        ({ Given, When, Then }) => {
          const unreadablePath = path.join(
            DEFAULT_CONFIG_ROOT,
            'commands',
            'unreadable.md',
          );
          Given(
            'I have a command file that the mock filesystem refuses to read',
            () => {
              resetDryAiSyncTestFixtures();
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
            },
          );
          When('I run `dry-ai sync`', async () => {
            const env = createTestEnv({ mockFileSystem });

            await expect(
              runCLI({
                argv: ['sync'],
                ...env.cliOptions,
              }),
            ).rejects.toThrow(`Could not read file: ${unreadablePath}`);
          });
          Then(
            'dry-ai surfaces unreadable discovered sources as failures instead of skipping them quietly',
            () => {
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(false);
            },
          );
        },
      );
      r.RuleScenario(
        'Surface filesystem errors from writing a target file',
        ({ Given, When, Then }) => {
          const failingOutputPath = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'write-fails.prompt.md',
          );
          Given(
            'I have a command source and a Copilot output path rigged to fail writes',
            () => {
              resetDryAiSyncTestFixtures();
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
              mockFailWriteFile({
                handle: mockFileSystem,
                absolutePath: failingOutputPath,
                message: 'write target failed',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            const env = createTestEnv({ mockFileSystem });

            await expect(
              runCLI({
                argv: ['sync'],
                ...env.cliOptions,
              }),
            ).rejects.toThrow(`Could not write file: ${failingOutputPath}`);
          });
          Then(
            'dry-ai surfaces failed writes to a target file as hard errors',
            () => {
              expect(mockFileSystem.files.has(failingOutputPath)).toBe(false);
              expect(
                mockFileSystem.files.has(
                  path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
                ),
              ).toBe(false);
            },
          );
        },
      );
      r.RuleScenario(
        'Surface filesystem failures when applying a directory skill target',
        ({ Given, When, Then }) => {
          const targetDir = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'skills',
            'error-skill',
          );
          type SkillMirrorScenario = 'emptyDir' | 'copy';
          let results: {
            scenario: SkillMirrorScenario;
            caught: unknown;
          }[];

          Given(
            'I run subcases that each reset the mock, seed a skill, and break Copilot skill mirroring',
            () => {
              resetDryAiSyncTestFixtures();
            },
          );
          When('I run `dry-ai sync`', async () => {
            results = [];
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
              const env = createTestEnv({ mockFileSystem });

              try {
                await runCLI({
                  argv: ['sync'],
                  ...env.cliOptions,
                });
                results.push({ scenario, caught: undefined });
              } catch (error) {
                results.push({ scenario, caught: error });
              }
            }
          });
          Then(
            'dry-ai aborts the run when copying a directory skill target fails',
            () => {
              expect(results.map((entry) => entry.scenario)).toEqual([
                'emptyDir',
                'copy',
              ]);
              expect(String(results[0].caught)).toContain(
                `Could not prepare directory: ${targetDir}`,
              );
              expect(String(results[1].caught)).toContain(
                `Could not copy into the sync output (${path.join(targetDir, 'SKILL.md')}).`,
              );
            },
          );
        },
      );
      r.RuleScenario(
        'Surface write failures when persisting sync-manifest.json',
        ({ Given, When, Then }) => {
          const manifestPath = normalizeMockPath(
            path.join(DEFAULT_CONFIG_ROOT, 'sync-manifest.json'),
          );
          let env: TestEnv;
          Given(
            'I have one valid command source and the manifest path refuses writes',
            () => {
              resetDryAiSyncTestFixtures();
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'solo-manifest-write-fail.md',
                ),
                content: [
                  '---',
                  'name: solo-manifest-write-fail',
                  'description: Solo command',
                  '---',
                  '',
                  'Body',
                  '',
                ].join('\n'),
              });
              mockFailWriteFile({
                handle: mockFileSystem,
                absolutePath: manifestPath,
                message: 'manifest write failed (test)',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then(
            'dry-ai fails when writing the manifest after applying changes',
            () => {
              expect(env.effectStderrMessages[0]).toBe(
                `Could not write file: ${manifestPath}\n`,
              );
            },
          );
        },
      );
      r.RuleScenario(
        'Surface removePath failures when deleting stale managed outputs',
        ({ Given, When, Then }) => {
          const staleOutputPath = normalizeMockPath(
            getBasicCommandOutputPath('copilot'),
          );
          let env: TestEnv;
          Given(
            'I synced the basic trio then deleted the command source only',
            async () => {
              resetDryAiSyncTestFixtures();
              arrangeBasicSources();
              env = createTestEnv({ mockFileSystem });
              await runCLI({ argv: ['sync'], ...env.cliOptions });
              removeMockPath({
                handle: mockFileSystem,
                targetPath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'commands',
                  'my-cmd.md',
                ),
              });
              mockFailRemove({
                handle: mockFileSystem,
                absolutePath: staleOutputPath,
                message: 'remove stale failed (test)',
              });
            },
          );
          When('I run `dry-ai sync` again', async () => {
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then(
            'dry-ai fails while removing a former managed output path',
            () => {
              expect(env.effectStderrMessages).toEqual([
                `Could not remove path: ${staleOutputPath}\n`,
              ]);
            },
          );
        },
      );
      r.RuleScenario(
        'Surface glob failures while discovering markdown sources',
        ({ Given, When, Then }) => {
          let env: TestEnv;
          Given('I have a command file under the config commands root', () => {
            resetDryAiSyncTestFixtures();
            storeMockTextFile({
              handle: mockFileSystem,
              filePath: path.join(
                DEFAULT_CONFIG_ROOT,
                'commands',
                'glob-fail.md',
              ),
              content: [
                '---',
                'name: glob-fail',
                'description: Glob fail',
                '---',
                '',
                'Body',
                '',
              ].join('\n'),
            });
          });
          When(
            'I run `dry-ai sync` after glob is rigged to reject once',
            async () => {
              env = createTestEnv({ mockFileSystem });
              mockedGlob.mockImplementationOnce(() =>
                Promise.reject(new Error('simulated glob failure')),
              );
              await runCLI({
                argv: ['sync'],
                ...env.cliOptions,
              }).catch(() => undefined);
            },
          );
          Then('dry-ai fails while globbing command sources', () => {
            const rootDir = normalizeMockPath(
              path.join(DEFAULT_CONFIG_ROOT, 'commands'),
            );
            expect(env.effectStderrMessages[0]).toBe(
              `Glob markdown files under ${rootDir}\n`,
            );
          });
        },
      );
      r.RuleScenario(
        'Surface read failures while hashing skill file contents',
        ({ Given, When, Then }) => {
          const skillMd = normalizeMockPath(
            path.join(
              DEFAULT_CONFIG_ROOT,
              'skills',
              'hash-read-fail',
              'SKILL.md',
            ),
          );
          let env: TestEnv;
          Given(
            'a skill SKILL.md cannot be read during content hashing (simulated)',
            () => {
              resetDryAiSyncTestFixtures();
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: path.join(
                  DEFAULT_CONFIG_ROOT,
                  'skills',
                  'hash-read-fail',
                  'SKILL.md',
                ),
                content: '# Hash read fail\n',
              });
              mockFailReadFileBytes({
                handle: mockFileSystem,
                absolutePath: skillMd,
                message: 'hash read failed (test)',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });
            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            }).catch(() => undefined);
          });
          Then('dry-ai fails while reading bytes for the skill hash', () => {
            expect(env.effectStderrMessages[0]).toBe(
              `Could not read file while hashing skill content: ${skillMd}\n`,
            );
          });
        },
      );
      r.RuleScenario(
        'Surface ensureDir failures before a write or copy',
        ({ Given, When, Then }) => {
          const failingParentDir = path.join(
            VIRTUAL_HOME_DIR,
            '.cursor',
            'skills',
            'ensure-dir-error',
          );
          Given(
            'I have a command source and a Cursor skill parent directory rigged to fail mkdir',
            () => {
              resetDryAiSyncTestFixtures();
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
              mockFailMakeDirectory({
                handle: mockFileSystem,
                absolutePath: failingParentDir,
                message: 'ensureDir failed',
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            const env = createTestEnv({ mockFileSystem });

            await expect(
              runCLI({
                argv: ['sync'],
                ...env.cliOptions,
              }),
            ).rejects.toThrow(
              `Could not write file: ${path.join(failingParentDir, 'SKILL.md')}`,
            );
          });
          Then(
            'dry-ai stops the workflow on directory creation failures before writes or copies proceed',
            () => {
              expect(
                mockFileSystem.files.has(
                  path.join(failingParentDir, 'SKILL.md'),
                ),
              ).toBe(false);
            },
          );
        },
      );
    },
  );
  f.Rule(
    'Empty configs write empty sync state without touching untracked outputs',
    (r) => {
      r.RuleScenario(
        'Sync an empty config without touching untracked outputs',
        ({ Given, When, Then }) => {
          const untrackedOutput = path.join(
            VIRTUAL_HOME_DIR,
            '.copilot',
            'prompts',
            'hand-written.prompt.md',
          );
          const untrackedContent = '# Hand written\n';
          let env: TestEnv;

          Given(
            'the config tree is empty but an unmanaged Copilot prompt already exists under home',
            () => {
              resetDryAiSyncTestFixtures();
              storeMockTextFile({
                handle: mockFileSystem,
                filePath: untrackedOutput,
                content: untrackedContent,
              });
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({
              mockFileSystem,
            });

            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            });
          });
          Then(
            'dry-ai writes empty sync state without creating agent outputs or touching untracked files',
            () => {
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);

              expect(
                readMockTextFile({
                  handle: mockFileSystem,
                  filePath: untrackedOutput,
                }),
              ).toBe(untrackedContent);

              expect(readSyncManifest().outputs).toEqual([]);

              expect(
                [...mockFileSystem.files.keys()].filter(
                  (filePath) =>
                    filePath !== untrackedOutput &&
                    !filePath.endsWith('sync-manifest.json'),
                ),
              ).toEqual([]);
            },
          );
        },
      );
    },
  );
  f.Rule(
    'Sync reports describe applied, removed, skipped, and unchanged work consistently',
    (r) => {
      r.RuleScenario(
        'Render a coherent report for mixed applied and skipped work',
        ({ Given, When, Then }) => {
          let env: TestEnv;

          Given(
            'I have a command and skill that share a name so installs and skips appear together',
            () => {
              resetDryAiSyncTestFixtures();
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
            },
          );
          When('I run `dry-ai sync`', async () => {
            env = createTestEnv({ mockFileSystem });

            await runCLI({
              argv: ['sync'],
              ...env.cliOptions,
            });
          });
          Then(
            'dry-ai renders applied work and skipped conflicts coherently in the same report',
            () => {
              expect(env.cmderStdoutMessages).toEqual([]);
              expect(env.cmderStderrMessages).toEqual([]);
              expect(env.effectStderrMessages).toEqual([]);

              const report = stripAnsi(env.effectStdoutMessages.join(''));
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
            },
          );
        },
      );
    },
  );
});
