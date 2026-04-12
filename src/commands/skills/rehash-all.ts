import fs from 'fs-extra';
import type { AgentsContext } from '../../lib/context.js';
import {
  computeDirectoryHashes,
  createUpdatedSkillRecord,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Refreshes the stored file hashes for every managed skill using current local directory contents.
 */
export async function runSkillsRehashAllCommand(
  context: AgentsContext,
): Promise<void> {
  let lockfile = await loadSkillsLockfile(context);

  if (lockfile.skills.length === 0) {
    console.log('No managed skills to rehash.');
    return;
  }

  const rehashedLines: string[] = [];
  const skippedLines: string[] = [];

  for (const managedSkill of lockfile.skills) {
    const targetDir = getManagedSkillDirectory(context, {
      skillName: managedSkill.name,
    });

    if (!(await fs.pathExists(targetDir))) {
      skippedLines.push(
        `- ${formatManagedSkillSummary(managedSkill)} missing-local-directory`,
      );
      continue;
    }

    const installedFiles = await computeDirectoryHashes(targetDir);
    const updatedSkill = createUpdatedSkillRecord({
      commit: managedSkill.commit,
      existingSkill: managedSkill,
      files: installedFiles,
      updatedAt: timestampNow(),
    });

    lockfile = upsertManagedSkill(lockfile, { updatedSkill });
    rehashedLines.push(`- ${formatManagedSkillSummary(updatedSkill)}`);
  }

  await saveSkillsLockfile(context, { lockfile });

  if (rehashedLines.length > 0) {
    console.log(
      `Rehashed ${rehashedLines.length} managed skills:\n${rehashedLines.join('\n')}`,
    );
  } else {
    console.log('No managed skills were rehashed.');
  }

  if (skippedLines.length > 0) {
    console.warn(
      `Skipped ${skippedLines.length} managed skills because the local directory is missing:\n${skippedLines.join('\n')}`,
    );
  }
}
