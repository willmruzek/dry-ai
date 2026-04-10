import type { AgentsContext } from '../../lib/context.js';
import {
  createUpdatedSkillRecord,
  fetchRemoteSkillSnapshot,
  findManagedSkill,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  replaceManagedSkillDirectory,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Updates one managed skill from its tracked remote source and refreshes the lockfile.
 */
export async function runSkillsUpdateCommand(
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

  const snapshot = await fetchRemoteSkillSnapshot({
    ref: managedSkill.ref,
    repo: managedSkill.repo,
    skillPath: managedSkill.path,
  });

  try {
    await replaceManagedSkillDirectory({
      targetDir: getManagedSkillDirectory(context, { skillName }),
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

  await saveSkillsLockfile(context, {
    lockfile: upsertManagedSkill(lockfile, { updatedSkill }),
  });

  console.log(`Updated ${formatManagedSkillSummary(updatedSkill)}`);
}
