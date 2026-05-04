import fs from 'fs-extra';

import type { CommandEnv } from '../cli.js';
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
    !(await fs.pathExists(context.inputRoot))
  ) {
    throw new Error(`Config root does not exist: ${context.inputRoot}`);
  }

  await ensureTargetDirectories(targetRoots);

  const previousManifest = await loadSyncManifest(
    context.syncManifestPath,
    runtime,
  );

  const desiredSpecs = await buildDesiredSyncSpecs(context, runtime);
  const changes = prepareSyncChanges({ previousManifest, desiredSpecs });
  const result = await applySyncChanges(changes);

  await saveSyncManifest(
    context.syncManifestPath,
    createSyncManifest([
      ...collectManifestEntriesFromApplied(result.appliedSpecs),
      ...changes.preservedEntries,
    ]),
  );

  runtime.logInfo(renderSyncReport(result, changes));
}
