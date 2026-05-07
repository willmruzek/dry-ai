import { Effect } from 'effect';

import type { CommandEnv } from '../lib/command-env.js';
import { pathExistsInFileSystem } from '../lib/skills.js';
import {
  applySyncChanges,
  buildDesiredSyncSpecs,
  collectManifestEntriesFromApplied,
  createSyncManifest,
  ensureTargetDirectories,
  loadSyncManifest,
  prepareSyncChanges,
  renderSyncReport,
  saveSyncManifest,
} from '../lib/sync.js';

/**
 * Effect program: validate config root when overridden, ensure targets, load
 * manifest, compute and apply sync changes, persist manifest, then log the
 * report. Composes with `Effect.runPromise` or `Effect.provide` in tests
 * without involving Commander.
 */
export function syncEffect(options: {
  env: CommandEnv;
}): Effect.Effect<void, never, never> {
  const { env } = options;
  const { context, rootOptions, runtime } = env;
  const { targetRoots } = context;

  return Effect.gen(function* () {
    if (
      rootOptions.configRoot !== undefined &&
      !(yield* Effect.promise(() =>
        pathExistsInFileSystem(env, context.inputRoot),
      ))
    ) {
      throw new Error(`Config root does not exist: ${context.inputRoot}`);
    }

    yield* Effect.promise(() => ensureTargetDirectories(env, targetRoots));

    const previousManifest = yield* Effect.promise(() =>
      loadSyncManifest(env, context.syncManifestPath),
    );

    const desiredSpecs = yield* Effect.promise(() =>
      buildDesiredSyncSpecs(env),
    );
    const changes = prepareSyncChanges({ previousManifest, desiredSpecs });
    const result = yield* Effect.promise(() => applySyncChanges(env, changes));

    yield* Effect.promise(() =>
      saveSyncManifest(
        env,
        context.syncManifestPath,
        createSyncManifest([
          ...collectManifestEntriesFromApplied(result.appliedSpecs),
          ...changes.preservedEntries,
        ]),
      ),
    );

    runtime.logInfo(renderSyncReport(result, changes));
  });
}

/**
 * Runs the sync command, writing all command, rule, and skill outputs into their agent target directories.
 */
export async function runSyncCommand(env: CommandEnv): Promise<void> {
  return Effect.runPromise(syncEffect({ env }));
}
