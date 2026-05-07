import type { CommandEnv } from '../../lib/command-env.js';
import {
  findManagedSkill,
  formatManagedSkillSummary,
  loadSkillsLockfile,
  removeManagedSkill,
  removeManagedSkillDirectory,
  saveSkillsLockfile,
} from '../../lib/skills.js';

/**
 * Removes a managed skill from the local directory and updates the lockfile.
 */
export async function runSkillsRemoveCommand(
  env: CommandEnv,
  input: {
    skillName: string;
  },
): Promise<void> {
  const { runtime } = env;
  const { skillName } = input;

  const lockfile = await loadSkillsLockfile(env);
  const managedSkill = findManagedSkill(lockfile, { name: skillName });

  if (!managedSkill) {
    throw new Error(`Managed skill not found: ${skillName}`);
  }

  await removeManagedSkillDirectory(env, { skillName });
  await saveSkillsLockfile(env, {
    lockfile: removeManagedSkill(lockfile, { name: skillName }),
  });

  runtime.logInfo(`Removed ${formatManagedSkillSummary(managedSkill)}`);
}
