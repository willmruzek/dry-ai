import { Command } from 'commander';
import { z } from 'zod';
import { addSkillsCommand } from './commands/skills/index.js';
import { runSyncCommand } from './commands/sync.js';
import { describeSupportedAgents } from './lib/agents.js';
import {
  nonEmptyOptionStringSchema,
  parseOptionValue,
  parseOptionsObject,
} from './lib/command-options.js';
import {
  createAgentsContext,
  resolveRequestedConfigRoot,
  resolveRequestedOutputRoot,
  type AgentsContext,
} from './lib/context.js';

const rootOptionsSchema = z.object({
  test: z.boolean().optional().default(false),
  configRoot: nonEmptyOptionStringSchema.optional(),
  outputRoot: nonEmptyOptionStringSchema.optional(),
});

export type RootOptions = z.output<typeof rootOptionsSchema>;

/**
 * Raw stdout/stderr write functions, without newline conventions. These are
 * the CLI-layer primitive used by Commander for help and version output; they
 * also back the higher-level {@link CLIRuntime}.
 */
export type StdioWriters = {
  writeOut: (output: string) => void;
  writeErr: (output: string) => void;
};

/**
 * The line-oriented output interface available to every command action.
 *
 * Both methods append a trailing newline. The `log*` prefix is used to make
 * call sites trivially greppable ("where do we emit CLI output?") without
 * colliding with `console.log` / `console.warn` or arbitrary variables.
 *
 * Commands should not reach for the underlying {@link StdioWriters.writeOut}
 * / {@link StdioWriters.writeErr} stream writes; that raw byte-level stream
 * access is confined to the CLI layer (Commander help/version output).
 */
export type CLIRuntime = {
  /** Writes an informational message to stdout, with an appended newline. */
  logInfo: (message: string) => void;
  /** Writes a warning message to stderr, with an appended newline. */
  logWarn: (message: string) => void;
};

/**
 * The shared environment passed into every command action: the
 * resolved domain context plus the runtime used for CLI output.
 */
export type CommandEnv = {
  context: AgentsContext;
  runtime: CLIRuntime;
};

export type CLIOptions = {
  executableName?: string;
  version: string;
  stdioWriters?: StdioWriters;
};

type ResolvedCLIOptions = {
  executableName: string;
  version: string;
  stdioWriters: StdioWriters;
};

/**
 * Parses the top-level CLI options into a validated shape.
 */
function getRootOptions(program: Command): RootOptions {
  return parseOptionsObject({
    schema: rootOptionsSchema,
    options: program.opts(),
    optionsLabel: 'root options',
  });
}

/**
 * Returns true if --test or --output-root was passed.
 */
function requestedOutputRootWasUsed(rootOptions: RootOptions): boolean {
  return rootOptions.test || rootOptions.outputRoot !== undefined;
}

/**
 * Builds an AgentsContext from the parsed root options, expanding ~ in paths and applying --test path defaults.
 */
export function resolveActiveContext(rootOptions: RootOptions): AgentsContext {
  const requestedConfigRoot = resolveRequestedConfigRoot({
    ...(rootOptions.configRoot ? { configRoot: rootOptions.configRoot } : {}),
  });
  const requestedOutputRoot = resolveRequestedOutputRoot({
    test: rootOptions.test,
    ...(rootOptions.outputRoot ? { outputRoot: rootOptions.outputRoot } : {}),
  });

  return createAgentsContext({
    ...(requestedConfigRoot ? { inputRoot: requestedConfigRoot } : {}),
    ...(requestedOutputRoot ? { outputRoot: requestedOutputRoot } : {}),
  });
}

/**
 * Derives a {@link CLIRuntime} from a pair of raw stdio writers by wrapping
 * each writer with the line-oriented newline convention.
 */
function wrapStdioWriters(stdioWriters: StdioWriters): CLIRuntime {
  return {
    logInfo(message) {
      stdioWriters.writeOut(`${message}\n`);
    },
    logWarn(message) {
      stdioWriters.writeErr(`${message}\n`);
    },
  };
}

/**
 * Creates the production stdio writers backed by the real process streams.
 */
export function createProductionStdioWriters(): StdioWriters {
  return {
    writeOut(output) {
      process.stdout.write(output);
    },
    writeErr(output) {
      process.stderr.write(output);
    },
  };
}

/**
 * Merges the provided CLIOptions with production defaults, returning a fully resolved options object.
 */
function resolveCLIOptions(options: CLIOptions): ResolvedCLIOptions {
  return {
    executableName: options.executableName ?? 'dryai',
    version: options.version,
    stdioWriters: options.stdioWriters ?? createProductionStdioWriters(),
  };
}

/**
 * Builds and returns the Commander program with all subcommands and global flags registered.
 */
export function createCLI(options: CLIOptions): Command {
  const resolvedOptions = resolveCLIOptions(options);
  const program = new Command();
  const executableName = resolvedOptions.executableName;
  const stdioWriters = resolvedOptions.stdioWriters;
  const runtime = wrapStdioWriters(stdioWriters);
  const resolveEnv = (): CommandEnv => ({
    context: resolveActiveContext(getRootOptions(program)),
    runtime,
  });

  program.configureOutput({
    writeOut: (output) => {
      stdioWriters.writeOut(output);
    },
    writeErr: (output) => {
      stdioWriters.writeErr(output);
    },
  });

  program
    .name(executableName)
    .usage('[options] <command> [args]')
    .helpOption('-h, --help', 'Display this message')
    .version(
      resolvedOptions.version,
      '-v, --version',
      'Display the current version',
    )
    .option(
      '--test',
      'Shortcut for writing generated output into ./output-test unless --output-root is also provided',
    )
    .option(
      '--config-root <path>',
      'Read configs from a different root instead of ~/.config/dryai',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--config-root',
      }),
    )
    .option(
      '--output-root <path>',
      'Write generated output under a different root instead of the default home directory',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--output-root',
      }),
    )
    .helpCommand(false)
    .action(() => {
      program.outputHelp();
    });

  program
    .command('sync')
    .description(
      `Sync generated output into ${describeSupportedAgents()} targets`,
    )
    .action(async () => {
      const rootOptions = getRootOptions(program);
      const env = resolveEnv();

      await runSyncCommand(env);

      if (requestedOutputRootWasUsed(rootOptions)) {
        runtime.logInfo(
          `Generated output written to ${env.context.outputRoot}`,
        );
      }
    });

  addSkillsCommand({
    program,
    commandName: `${executableName} skills`,
    resolveEnv,
  });

  return program;
}

/**
 * Parses argv and runs the matching command, returning the Commander program after completion.
 */
export async function runCLI(
  input: {
    argv: string[];
  } & CLIOptions,
): Promise<Command> {
  const { argv, ...options } = input;
  const program = createCLI(options);

  await program.parseAsync(argv, { from: 'user' });

  return program;
}
