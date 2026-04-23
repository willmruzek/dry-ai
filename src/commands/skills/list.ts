import type { CommandEnv } from '../../cli.js';
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
export async function runSkillsListCommand(env: CommandEnv): Promise<void> {
  const { context, runtime } = env;
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
    runtime.logInfo('No local skills found.');
    return;
  }

  runtime.logInfo(outputLines.join('\n'));
}
