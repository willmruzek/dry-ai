import type { FileSystem } from '@effect/platform/FileSystem';
import { Command } from 'commander';
import { Effect } from 'effect';
import type { Layer } from 'effect/Layer';

import { createCliLoggerLayer } from './cli/run-effect.js';
import { addSkillsCommand } from './commands/skills/index.js';
import { runSyncCommand } from './commands/sync.js';
import { describeSupportedAgents } from './lib/agents.js';
import type { CLIRuntime, CommandEnv } from './lib/command-env.js';
import {
  nonEmptyOptionStringSchema,
  parseOptionValue,
  parseOptionsObject,
  rootOptionsSchema,
  type RootOptions,
} from './lib/command-options.js';
import {
  createAgentsContext,
  resolveRequestedConfigRoot,
  resolveRequestedOutputRoot,
  type AgentsContext,
} from './lib/context.js';

export type { CLIRuntime, CommandEnv } from './lib/command-env.js';
export type { RootOptions } from './lib/command-options.js';

/**
 * Raw stdout/stderr write functions, without newline conventions. These are
 * the CLI-layer primitive used by Commander for help and version output; they
 * also feed {@link createCliLoggerLayer} so Effect logs share the same sinks.
 */
export type StdioWriters = {
  writeOut: (output: string) => void;
  writeErr: (output: string) => void;
};

export type CLIOptions = {
  executableName?: string;
  version: string;
  stdioWriters?: StdioWriters;
  exitOverride?: boolean;
  fileSystemLayer: Layer<FileSystem>;
};

type ResolvedCLIOptions = {
  executableName: string;
  version: string;
  stdioWriters: StdioWriters;
  fileSystemLayer: Layer<FileSystem>;
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
function wasRequestedOutputRootUsed(rootOptions: RootOptions): boolean {
  return rootOptions.test || rootOptions.outputRoot !== undefined;
}

/**
 * Create an AgentsContext from validated root CLI options, resolving and normalizing filesystem roots.
 *
 * Expands user home (`~`) in provided paths and applies the `--test` default output location when appropriate.
 *
 * @param rootOptions - Parsed and validated global CLI options
 * @returns An AgentsContext with `inputRoot` and/or `outputRoot` set when the corresponding options were resolved
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
 * Apply defaults to a CLIOptions object and return a fully populated ResolvedCLIOptions.
 *
 * @param options - Partial CLI configuration provided by the caller
 * @returns A normalized options object where `executableName` defaults to `"dry-ai"`, `stdioWriters` defaults to production writers, and `fileSystemLayer` is preserved
 */
function resolveCLIOptions(options: CLIOptions): ResolvedCLIOptions {
  return {
    executableName: options.executableName ?? 'dry-ai',
    version: options.version,
    stdioWriters: options.stdioWriters ?? createProductionStdioWriters(),
    fileSystemLayer: options.fileSystemLayer,
  };
}

/**
 * Create and configure the CLI program with global flags, output handling, and built-in subcommands.
 *
 * The returned program is preconfigured with global options (including --test, --config-root, --output-root),
 * output routing to the provided stdio writers, and the bundled subcommands (`sync` and `skills`).
 *
 * @param options - CLI configuration (may include executableName, version, stdioWriters, and the required fileSystemLayer)
 * @returns The configured Commander `Command` ready to parse and execute argv
 */
export function createCLI(options: CLIOptions): Command {
  const resolvedOptions = resolveCLIOptions(options);

  const program = new Command();

  const executableName = resolvedOptions.executableName;
  const stdioWriters = resolvedOptions.stdioWriters;
  const runtime: CLIRuntime = {
    fileSystemLayer: resolvedOptions.fileSystemLayer,
    loggerLayer: createCliLoggerLayer(stdioWriters),
  };

  const resolveEnv = (): CommandEnv => {
    const rootOptions = getRootOptions(program);

    return {
      context: resolveActiveContext(rootOptions),
      runtime,
      rootOptions,
    };
  };

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
      '--debug',
      'After a failed command, also log the full Effect failure cause on stderr (for troubleshooting)',
    )
    .option(
      '--config-root <path>',
      'Read configs from a different root instead of ~/.config/dry-ai',
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

      if (wasRequestedOutputRootUsed(rootOptions)) {
        await Effect.runPromise(
          Effect.logInfo(
            `Generated output written to ${env.context.outputRoot}`,
          ).pipe(Effect.provide(runtime.loggerLayer)),
        );
      }
    });

  addSkillsCommand({
    program,
    commandName: executableName,
    resolveEnv,
  });

  return program;
}

/**
 * Parses argv and runs the matching command.
 */
export async function runCLI(
  input: {
    argv: string[];
  } & CLIOptions,
): Promise<void> {
  const { argv, exitOverride, ...options } = input;

  const program = createCLI(options);

  if (exitOverride === true) {
    program.exitOverride();
  }

  await program.parseAsync(argv, { from: 'user' });
}
