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
 * Runs the sync command, writing all command, rule, and skill outputs into their agent target directories.
 */
export async function runSyncCommand(env: CommandEnv): Promise<void> {
  const { context, rootOptions, runtime } = env;

  const { targetRoots } = context;

  if (
    rootOptions.configRoot !== undefined &&
    !(await pathExistsInFileSystem(env, context.inputRoot))
  ) {
    throw new Error(`Config root does not exist: ${context.inputRoot}`);
  }

  await ensureTargetDirectories(env, targetRoots);

  const previousManifest = await loadSyncManifest(
    env,
    context.syncManifestPath,
  );

  const desiredSpecs = await buildDesiredSyncSpecs(env);
  const changes = prepareSyncChanges({ previousManifest, desiredSpecs });
  const result = await applySyncChanges(env, changes);

  await saveSyncManifest(
    env,
    context.syncManifestPath,
    createSyncManifest([
      ...collectManifestEntriesFromApplied(result.appliedSpecs),
      ...changes.preservedEntries,
    ]),
  );

  runtime.logInfo(renderSyncReport(result, changes));
}
