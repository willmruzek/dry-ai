#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageDirectory } from 'package-directory';
import { z } from 'zod';

import { runCLI } from './cli.js';

const EXECUTABLE_NAME = 'dry-ai';

/**
 * Reads the CLI version from the package manifest at the repository root.
 */
async function getCLIVersion(): Promise<string> {
  const packageRoot = await packageDirectory({
    cwd: path.dirname(fileURLToPath(import.meta.url)),
  });

  if (!packageRoot) {
    throw new Error('Could not find package root');
  }

  const packageJsonPath = path.join(packageRoot, 'package.json');
  const rawPackageJson = await fs.readFile(packageJsonPath, 'utf8');
  const parsedPackageJson: unknown = JSON.parse(rawPackageJson);

  const packageJsonSchema = z.object({
    version: z.string().min(1),
  });

  return packageJsonSchema.parse(parsedPackageJson).version;
}

/**
 * Configures and runs the executable CLI entrypoint with the production CLI options.
 */
async function main(): Promise<void> {
  await runCLI({
    argv: process.argv.slice(2),
    executableName: EXECUTABLE_NAME,
    version: await getCLIVersion(),
  });
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(message);
  process.exitCode = 1;
}
