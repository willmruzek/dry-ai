import type { AgentsContext } from '../lib/context.js';
import { installToTargets } from '../lib/install.js';

export async function runInstallCommand(context: AgentsContext): Promise<void> {
  await installToTargets(context, { targetRoots: context.targetRoots });
}
