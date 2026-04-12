import fs from 'fs-extra';
import type { AgentsContext } from '../../lib/context.js';
import {
  computeDirectoryHashes,
  createUpdatedSkillRecord,
  findManagedSkill,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Refreshes the stored file hashes for one managed skill using the current local directory contents.
 */
export async function runSkillsRehashCommand(
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

  const targetDir = getManagedSkillDirectory(context, { skillName });

  if (!(await fs.pathExists(targetDir))) {
    throw new Error(`Managed skill directory not found: ${targetDir}`);
  }

  const installedFiles = await computeDirectoryHashes(targetDir);
  const updatedSkill = createUpdatedSkillRecord({
    commit: managedSkill.commit,
    existingSkill: managedSkill,
    files: installedFiles,
    updatedAt: timestampNow(),
  });

  await saveSkillsLockfile(context, {
    lockfile: upsertManagedSkill(lockfile, { updatedSkill }),
  });

  console.log(`Rehashed ${formatManagedSkillSummary(updatedSkill)}`);
}
