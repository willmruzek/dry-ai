#!/usr/bin/env node

import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runInstallCommand } from './commands/install.js';
import { addSkillsCommand } from './commands/skills/index.js';
import {
  nonEmptyOptionStringSchema,
  parseOptionValue,
  parseOptionsObject,
} from './lib/command-options.js';
import {
  createAgentsContext,
  resolveRequestedOutputRoot,
  type AgentsContext,
} from './lib/context.js';

const rootOptionsSchema = z.object({
  test: z.boolean().optional().default(false),
  input: nonEmptyOptionStringSchema.optional(),
  output: nonEmptyOptionStringSchema.optional(),
});

const EXECUTABLE_NAME = 'dryai';

type RootOptions = z.output<typeof rootOptionsSchema>;

/**
 * Reads the CLI version from the package manifest at the repository root.
 */
async function readCliVersion(): Promise<string> {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageJsonPath = path.resolve(
    currentFilePath,
    '..',
    '..',
    'package.json',
  );
  const rawPackageJson = await fs.readFile(packageJsonPath, 'utf8');
  const parsedPackageJson: unknown = JSON.parse(rawPackageJson);
  const packageJsonSchema = z.object({
    version: z.string().min(1),
  });

  return packageJsonSchema.parse(parsedPackageJson).version;
}

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
 * Returns the active context after applying root-level input and output
 * overrides.
 */
function resolveActiveContext(program: Command): AgentsContext {
  const rootOptions = getRootOptions(program);
  const requestedOutputRoot = resolveRequestedOutputRoot({
    test: rootOptions.test,
    ...(rootOptions.output ? { outputRoot: rootOptions.output } : {}),
  });
  const context = createAgentsContext({
    ...(rootOptions.input ? { inputRoot: rootOptions.input } : {}),
    ...(requestedOutputRoot ? { outputRoot: requestedOutputRoot } : {}),
  });

  return context;
}

/**
 * Configures and runs the agents CLI entrypoint.
 */
async function main(): Promise<void> {
  const program = new Command();
  const cliVersion = await readCliVersion();

  program
    .name(EXECUTABLE_NAME)
    .usage('[options] <command> [args]')
    .helpOption('-h, --help', 'Display this message')
    .version(cliVersion, '-v, --version', 'Display the current version')
    .option(
      '--test',
      'Shortcut for writing generated output into ./output-test unless --output is also provided',
    )
    .option(
      '--input <path>',
      'Read input configs from a different root instead of ~/.config/dryai',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--input',
      }),
    )
    .option(
      '--output <path>',
      'Write generated output under a different root instead of the default home directory',
      parseOptionValue({
        schema: nonEmptyOptionStringSchema,
        optionLabel: '--output',
      }),
    )
    .helpCommand(false)
    .action(() => {
      program.outputHelp();
    });

  program
    .command('install')
    .description('Install generated output into Copilot and Cursor targets')
    .usage('install')
    .action(async () => {
      const activeContext = resolveActiveContext(program);
      await runInstallCommand(activeContext);

      if (requestedOutputRootWasUsed(program)) {
        console.log(`Generated output written to ${activeContext.outputRoot}`);
      }
    });

  addSkillsCommand({
    parent: program,
    commandName: `${EXECUTABLE_NAME} skills`,
    resolveContext: () => resolveActiveContext(program),
  });

  await program.parseAsync(process.argv);
}

/**
 * Returns whether the current invocation requested a non-default output root.
 */
function requestedOutputRootWasUsed(program: Command): boolean {
  const rootOptions = getRootOptions(program);
  return (
    resolveRequestedOutputRoot({
      test: rootOptions.test,
      ...(rootOptions.output ? { outputRoot: rootOptions.output } : {}),
    }) !== undefined
  );
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(message);
  process.exitCode = 1;
}
