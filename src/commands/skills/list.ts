import type { AgentsContext } from '../../lib/context.js';
import {
  ensureSkillsRoot,
  findManagedSkill,
  formatManagedSkillSummary,
  listLocalSkillDirectories,
  loadSkillsLockfile,
} from '../../lib/skills.js';

/**
 * Lists local skills and annotates which ones are managed by the lockfile.
 */
export async function runSkillsListCommand(
  context: AgentsContext,
): Promise<void> {
  await ensureSkillsRoot(context);

  const [localSkillDirectories, lockfile] = await Promise.all([
    listLocalSkillDirectories(context),
    loadSkillsLockfile(context),
  ]);

  const localSkillLines = localSkillDirectories.map((skillName) => {
    const managedSkill = findManagedSkill(lockfile, { name: skillName });
    return managedSkill
      ? `- ${formatManagedSkillSummary(managedSkill)}`
      : `- ${skillName} unmanaged`;
  });

  const missingManagedLines = lockfile.skills
    .filter(
      (managedSkill) => !localSkillDirectories.includes(managedSkill.name),
    )
    .map(
      (managedSkill) =>
        `- ${formatManagedSkillSummary(managedSkill)} missing-local-directory`,
    );

  const outputLines = [...localSkillLines, ...missingManagedLines];

  if (outputLines.length === 0) {
    console.log('No local skills found.');
    return;
  }

  console.log(outputLines.join('\n'));
}
