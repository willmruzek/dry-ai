import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { createCLI, type CLIOptions } from '../src/cli.js';

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

async function runCLIExpectingError(
  input: { argv: string[] } & CLIOptions,
): Promise<CommanderError> {
  try {
    await runCLIHelp(input);
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      return error;
    }

    throw error;
  }

  throw new Error(
    'Expected the CLI to reject with a CommanderError, but it resolved successfully.',
  );
}

describe('runCLI', () => {
  describe('happy paths', () => {
    it.each<[string, string[]]>([
      ['no args', []],
      ['--help', ['--help']],
      ['-h', ['-h']],
    ])('prints `dry-ai` (root) help with %s', async (_label, argv) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv,
        ...cliOptions,
      });

      expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
      expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
        "Usage: dry-ai [options] <command> [args]

        Options:
          -v, --version         Display the current version
          --test                Shortcut for writing generated output into ./output-test
                                unless --output-root is also provided
          --config-root <path>  Read configs from a different root instead of
                                ~/.config/dry-ai
          --output-root <path>  Write generated output under a different root instead of
                                the default home directory
          -h, --help            Display this message

        Commands:
          sync                  Sync generated output into Copilot and Cursor targets
          skills                Manage imported skills
        "
      `);
    });

    it.each(['-v', '--version'])('prints the version with %s', async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: [flag],
        ...cliOptions,
      });

      expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
      expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "9.9.9-test
          "
        `);
    });

    it.each(['--help', '-h'])('prints `sync` help with %s', async (flag) => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      await runCLIHelp({
        argv: ['sync', flag],
        ...cliOptions,
      });

      expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
      expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
        "Usage: dry-ai sync [options]

        Sync generated output into Copilot and Cursor targets

        Options:
          -h, --help  Display this message
        "
      `);
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

      expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
      expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
        "Usage: dry-ai skills <subcommand> [args]

        Manage imported skills

        Options:
          -h, --help               Display this message

        Commands:
          list                     List local skills
          add [options] <repo>     Add managed skills from a remote repository
          remove <name>            Remove a managed skill
          rehash <name>            Refresh stored file hashes for one managed skill
          rehash-all               Refresh stored file hashes for all managed skills
          update [options] <name>  Update a managed skill from its tracked source
          update-all [options]     Update all managed skills from their tracked sources
        Examples:
          dry-ai skills list
          dry-ai skills add anthropics/skills --skill skill-creator
          dry-ai skills add anthropics/skills --path . --skill review-helper
          dry-ai skills add anthropics/skills --path tools --skill review-helper
          dry-ai skills add vercel-labs/agent-skills --skill pr-review commit
          dry-ai skills rehash skill-creator
          dry-ai skills update skill-creator
        "
      `);
    });

    it.each(['--help', '-h'])(
      'prints `skills add` help with %s',
      async (flag) => {
        const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

        await runCLIHelp({
          argv: ['skills', 'add', flag],
          ...cliOptions,
        });

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills add [options] <repo>

          Add managed skills from a remote repository

          Options:
            --skill <names...>  Import one or more skills by directory name
            --path <repoPath>   Resolve each --skill from a different repository
                                subdirectory; use . for the repository root instead of the
                                default skills/ directory
            --as <name>         Store the imported skill under a different local managed
                                name
            --pin               Pin the import to the currently resolved commit instead of
                                tracking a moving ref
            --ref <gitRef>      Fetch a specific git ref instead of the remote default
            -h, --help          Display this message
          "
        `);
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

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills update [options] <name>

          Update a managed skill from its tracked source

          Options:
            --force     Overwrite local skill edits with the fetched remote copy
            -h, --help  Display this message
          "
        `);
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

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills update-all [options]

          Update all managed skills from their tracked sources

          Options:
            --force     Overwrite local skill edits with the fetched remote copy
            -h, --help  Display this message
          "
        `);
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

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills list [options]

          List local skills

          Options:
            -h, --help  Display this message
          "
        `);
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

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills remove [options] <name>

          Remove a managed skill

          Options:
            -h, --help  Display this message
          "
        `);
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

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills rehash [options] <name>

          Refresh stored file hashes for one managed skill

          Options:
            -h, --help  Display this message
          "
        `);
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

        expect(stderrMessages.join('')).toMatchInlineSnapshot(`""`);
        expect(stdoutMessages.join('')).toMatchInlineSnapshot(`
          "Usage: dry-ai skills rehash-all [options]

          Refresh stored file hashes for all managed skills

          Options:
            -h, --help  Display this message
          "
        `);
      },
    );
  });

  describe('sad paths', () => {
    it('rejects an unknown top-level subcommand (e.g. "dry-ai bogus") with a commander error', async () => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      const error = await runCLIExpectingError({
        argv: ['bogus'],
        ...cliOptions,
      });

      expect(error).toBeInstanceOf(CommanderError);
      expect(error.code).toBe('commander.excessArguments');
      expect(error.exitCode).toBe(1);

      expect(stdoutMessages).toEqual([]);
      expect(stderrMessages.join('')).toContain('too many arguments');
    });

    it('rejects an unknown subcommand under skills (e.g. "dry-ai skills bogus") with a commander error', async () => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      const error = await runCLIExpectingError({
        argv: ['skills', 'bogus'],
        ...cliOptions,
      });

      expect(error).toBeInstanceOf(CommanderError);
      expect(error.code).toBe('commander.excessArguments');
      expect(error.exitCode).toBe(1);

      expect(stdoutMessages).toEqual([]);
      const stderr = stderrMessages.join('');
      expect(stderr).toContain('too many arguments');
      expect(stderr).toContain("'skills'");
    });

    it('rejects an unknown root flag (e.g. "dry-ai --bogus sync") with a commander error', async () => {
      const { cliOptions, stderrMessages, stdoutMessages } = createTestEnv();

      const error = await runCLIExpectingError({
        argv: ['--bogus', 'sync'],
        ...cliOptions,
      });

      expect(error).toBeInstanceOf(CommanderError);
      expect(error.code).toBe('commander.unknownOption');
      expect(error.exitCode).toBe(1);

      expect(stdoutMessages).toEqual([]);
      expect(stderrMessages.join('')).toContain("unknown option '--bogus'");
    });
  });
});
