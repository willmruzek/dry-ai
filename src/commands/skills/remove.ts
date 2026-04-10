import type { AgentsContext } from '../../lib/context.js';
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
  context: AgentsContext,
  input: {
    skillName: string;
  },
): Promise<void> {
  const { skillName } = input;

  const lockfile = await loadSkillsLockfile(context);
  const managedSkill = findManagedSkill(lockfile, { name: skillName });

  if (!managedSkill) {
    throw new Error(`Managed skill not found: ${skillName}`);
  }

  await removeManagedSkillDirectory(context, { skillName });
  await saveSkillsLockfile(context, {
    lockfile: removeManagedSkill(lockfile, { name: skillName }),
  });

  console.log(`Removed ${formatManagedSkillSummary(managedSkill)}`);
}
