import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { createCLI, type CLIOptions } from '../src/cli.js';
import { describeSupportedAgents } from '../src/lib/agents.js';
import { createTestEnv } from './helpers.js';

function applyExitOverride(command: Command): void {
  command.exitOverride();

  for (const subcommand of command.commands) {
    applyExitOverride(subcommand);
  }
}

async function runCLIHelp(
  input: { argv: string[] } & CLIOptions,
): Promise<void> {
  const { argv, ...options } = input;
  const program = createCLI(options);

  applyExitOverride(program);

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error: unknown) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version')
    ) {
      return;
    }

    throw error;
  }
}

describe('runCLI', () => {
  it.each<[string, string[]]>([
    ['no args', []],
    ['--help', ['--help']],
    ['-h', ['-h']],
  ])('prints `dryai` (root) help with %s', async (_label, argv) => {
    const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

    await runCLIHelp({
      argv,
      ...cliOptions,
    });

    const stdout = stdoutMessages.join('');

    expect(stderrMessages).toEqual([]);
    expect(stdout).toContain('Usage: dryai [options] <command> [args]');
    expect(stdout).toContain('-v, --version');
    expect(stdout).toContain('--test');
    expect(stdout).toContain('--config-root <path>');
    expect(stdout).toContain('--output-root <path>');
    expect(stdout).toContain('-h, --help');
    expect(stdout).toContain('sync');
    expect(stdout).toContain(
      `Sync generated output into ${describeSupportedAgents()} targets`,
    );
    expect(stdout).toContain('skills');
    expect(stdout).toContain('Manage imported skills');
  });

  it.each(['-v', '--version'])('prints the version with %s', async (flag) => {
    const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

    await runCLIHelp({
      argv: [flag],
      ...cliOptions,
    });

    expect(stderrMessages).toEqual([]);
    expect(stdoutMessages.join('')).toContain('9.9.9-test');
  });

  it.each(['--help', '-h'])('prints `sync` help with %s', async (flag) => {
    const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

    await runCLIHelp({
      argv: ['sync', flag],
      ...cliOptions,
    });

    const stdout = stdoutMessages.join('');

    expect(stderrMessages).toEqual([]);
    expect(stdout).toContain('Usage: dryai sync [options]');
    expect(stdout).toContain(
      `Sync generated output into ${describeSupportedAgents()} targets`,
    );
    expect(stdout).toContain('-h, --help');
  });

  it.each<[string, string[]]>([
    ['no args', ['skills']],
    ['--help', ['skills', '--help']],
    ['-h', ['skills', '-h']],
  ])('prints `skills` help with %s', async (_label, argv) => {
    const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

    await runCLIHelp({
      argv,
      ...cliOptions,
    });

    const stdout = stdoutMessages.join('');

    expect(stderrMessages).toEqual([]);
    expect(stdout).toContain('Manage imported skills');
    expect(stdout).toContain('-h, --help');
    expect(stdout).toContain('list');
    expect(stdout).toContain('add [options] <repo>');
    expect(stdout).toContain('remove <name>');
    expect(stdout).toContain('rehash <name>');
    expect(stdout).toContain('rehash-all');
    expect(stdout).toContain('update [options] <name>');
    expect(stdout).toContain('update-all [options]');
    expect(stdout).toContain('Examples:');
    expect(stdout).toContain(
      'dryai skills add anthropics/skills --skill skill-creator',
    );

    expect(stdout).toContain('dryai skills list');
    expect(stdout).toContain(
      'dryai skills add anthropics/skills --skill skill-creator',
    );
    expect(stdout).toContain(
      'dryai skills add anthropics/skills --path . --skill review-helper',
    );
    expect(stdout).toContain(
      'dryai skills add anthropics/skills --path tools --skill review-helper',
    );
    expect(stdout).toContain(
      'dryai skills add vercel-labs/agent-skills --skill pr-review commit',
    );
    expect(stdout).toContain('dryai skills rehash skill-creator');
    expect(stdout).toContain('dryai skills update skill-creator');
  });

  it.each(['--help', '-h'])(
    'prints `skills add` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'add', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills add [options] <repo>');
      expect(stdout).toContain('--skill <names...>');
      expect(stdout).toContain('--path <repoPath>');
      expect(stdout).toContain('--as <name>');
      expect(stdout).toContain('--pin');
      expect(stdout).toContain('--ref <gitRef>');
      expect(stdout).toContain('-h, --help');
    },
  );

  it.each(['--help', '-h'])(
    'prints `skills update` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'update', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills update [options] <name>');
      expect(stdout).toContain('--force');
      expect(stdout).toContain('-h, --help');
    },
  );

  it.each(['--help', '-h'])(
    'prints `skills update-all` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'update-all', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills update-all [options]');
      expect(stdout).toContain('--force');
      expect(stdout).toContain('-h, --help');
    },
  );

  it.each(['--help', '-h'])(
    'prints `skills list` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'list', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills list');
      expect(stdout).toContain('List local skills');
      expect(stdout).toContain('-h, --help');
    },
  );

  it.each(['--help', '-h'])(
    'prints `skills remove` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'remove', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills remove [options] <name>');
      expect(stdout).toContain('Remove a managed skill');
      expect(stdout).toContain('-h, --help');
    },
  );

  it.each(['--help', '-h'])(
    'prints `skills rehash` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'rehash', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills rehash [options] <name>');
      expect(stdout).toContain(
        'Refresh stored file hashes for one managed skill',
      );
      expect(stdout).toContain('-h, --help');
    },
  );

  it.each(['--help', '-h'])(
    'prints `skills rehash-all` help with %s',
    async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['skills', 'rehash-all', flag],
        ...cliOptions,
      });

      const stdout = stdoutMessages.join('');

      expect(stderrMessages).toEqual([]);
      expect(stdout).toContain('Usage: dryai skills rehash-all');
      expect(stdout).toContain(
        'Refresh stored file hashes for all managed skills',
      );
      expect(stdout).toContain('-h, --help');
    },
  );
});
