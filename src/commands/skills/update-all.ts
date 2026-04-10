import type { AgentsContext } from '../../lib/context.js';
import {
  createUpdatedSkillRecord,
  fetchRemoteSkillSnapshot,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  replaceManagedSkillDirectory,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Updates every managed skill from its tracked remote source and saves the refreshed lockfile.
 */
export async function runSkillsUpdateAllCommand(
  context: AgentsContext,
): Promise<void> {
  let lockfile = await loadSkillsLockfile(context);

  if (lockfile.skills.length === 0) {
    console.log('No managed skills to update.');
    return;
  }

  const updatedLines: string[] = [];

  for (const managedSkill of lockfile.skills) {
    const snapshot = await fetchRemoteSkillSnapshot({
      ref: managedSkill.ref,
      repo: managedSkill.repo,
      skillPath: managedSkill.path,
    });

    try {
      await replaceManagedSkillDirectory({
        targetDir: getManagedSkillDirectory(context, {
          skillName: managedSkill.name,
        }),
        sourceDir: snapshot.sourceDir,
      });
    } finally {
      await snapshot.cleanup();
    }

    const updatedSkill = createUpdatedSkillRecord({
      commit: snapshot.commit,
      existingSkill: managedSkill,
      updatedAt: timestampNow(),
    });

    lockfile = upsertManagedSkill(lockfile, { updatedSkill });
    updatedLines.push(`- ${formatManagedSkillSummary(updatedSkill)}`);
  }

  await saveSkillsLockfile(context, { lockfile });
  console.log(
    `Updated ${updatedLines.length} managed skills:\n${updatedLines.join('\n')}`,
  );
}
