import type { FileSystem } from '@effect/platform/FileSystem';
import { Effect } from 'effect';

import { runCliEffect } from '../cli/run-effect.js';
import type { CommandEnv } from '../lib/command-env.js';
import { wasRequestedOutputRootUsed } from '../lib/command-options.js';
import { pathExistsInFileSystem } from '../lib/skills.js';
import {
  applySyncChanges,
  buildDesiredSyncSpecs,
  collectManifestEntriesFromApplied,
  ConfigRootMissingError,
  createSyncManifest,
  ensureTargetDirectories,
  loadSyncManifest,
  prepareSyncChanges,
  renderSyncReport,
  saveSyncManifest,
  type SyncEffectError,
} from '../lib/sync.js';

/**
 * Effect program: validate config root when overridden, ensure targets, load
 * manifest, compute and apply sync changes, persist manifest, log the report,
 * and when `--test` or `--output-root` was used, log where output was written.
 * Composes with `Effect.runPromise` or `Effect.provide` in tests without involving Commander.
 */
export function syncEffect(options: {
  env: CommandEnv;
}): Effect.Effect<void, SyncEffectError, FileSystem> {
  const { env } = options;
  const { context, rootOptions } = env;
  const { targetRoots } = context;

  return Effect.gen(function* () {
    if (
      rootOptions.configRoot !== undefined &&
      !(yield* pathExistsInFileSystem(context.inputRoot))
    ) {
      return yield* new ConfigRootMissingError({
        inputRoot: context.inputRoot,
      });
    }

    yield* ensureTargetDirectories(targetRoots);

    const previousManifest = yield* loadSyncManifest(context.syncManifestPath);

    const desiredSpecs = yield* buildDesiredSyncSpecs(env);
    const changes = prepareSyncChanges({ previousManifest, desiredSpecs });
    const result = yield* applySyncChanges(changes);

    yield* saveSyncManifest(
      context.syncManifestPath,
      createSyncManifest([
        ...collectManifestEntriesFromApplied(result.appliedSpecs),
        ...changes.preservedEntries,
      ]),
    );

    yield* Effect.logInfo(renderSyncReport(result, changes));

    if (wasRequestedOutputRootUsed(rootOptions)) {
      yield* Effect.logInfo(
        `Generated output written to ${context.outputRoot}`,
      );
    }
  });
}

/**
 * Runs the sync command, writing all command, rule, and skill outputs into their agent target directories.
 */
export async function runSyncCommand(env: CommandEnv): Promise<void> {
  return runCliEffect(
    env,
    syncEffect({ env }).pipe(Effect.provide(env.runtime.fileSystemLayer)),
  );
}
