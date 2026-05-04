import type { CommandEnv } from '../lib/command-env.js';
import { syncToTargets } from '../lib/sync.js';

/**
 * Runs the sync command, writing all command, rule, and skill outputs into their agent target directories.
 */
export async function runSyncCommand(env: CommandEnv): Promise<void> {
  const { context, runtime } = env;
  await syncToTargets(context, runtime);
}
