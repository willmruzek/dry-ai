#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { layer as nodeFileSystemLayer } from '@effect/platform-node/NodeFileSystem';
import { FileSystem } from '@effect/platform/FileSystem';
import { Effect, Schema } from 'effect';
import { packageDirectory } from 'package-directory';

import { runCLI } from './cli.js';
import { CliHandledFiberFailure } from './cli/run-effect.js';

const EXECUTABLE_NAME = 'dry-ai';

/**
 * Reads the CLI version from the package manifest at the repository root.
 */
async function readCliVersion(): Promise<string> {
  const packageJsonVersionSchema = Schema.parseJson(
    Schema.Struct({ version: Schema.String }),
  );

  const decodePackageJsonVersion = Schema.decodeUnknown(
    packageJsonVersionSchema,
  );

  return Effect.runPromise(
    Effect.gen(function* () {
      const packageRoot = yield* Effect.promise(() =>
        packageDirectory({
          cwd: path.dirname(fileURLToPath(import.meta.url)),
        }),
      );

      if (!packageRoot) {
        return yield* Effect.fail('Could not find package root');
      }

      const packageJsonPath = path.join(packageRoot, 'package.json');
      const fs = yield* FileSystem;
      const raw = yield* fs.readFileString(packageJsonPath);
      const pkg = yield* decodePackageJsonVersion(raw);

      return pkg.version;
    }).pipe(Effect.provide(nodeFileSystemLayer)),
  );
}

/**
 * Configures and runs the executable CLI entrypoint with the production CLI options.
 */
async function main(): Promise<void> {
  await runCLI({
    argv: process.argv.slice(2),
    executableName: EXECUTABLE_NAME,
    fileSystemLayer: nodeFileSystemLayer,
    version: await readCliVersion(),
  });
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof CliHandledFiberFailure) {
    process.exitCode = 1;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}
