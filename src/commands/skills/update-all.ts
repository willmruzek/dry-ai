import type { AgentsContext } from '../../lib/context.js';
import {
  computeDirectoryHashes,
  createUpdatedSkillRecord,
  detectLocalSkillEdits,
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
  input: {
    force: boolean;
  },
): Promise<void> {
  let lockfile = await loadSkillsLockfile(context);

  if (lockfile.skills.length === 0) {
    console.log('No managed skills to update.');
    return;
  }

  const updatedLines: string[] = [];
  const skippedLines: string[] = [];

  for (const managedSkill of lockfile.skills) {
    const targetDir = getManagedSkillDirectory(context, {
      skillName: managedSkill.name,
    });
    const localEditState = await detectLocalSkillEdits({
      skillDir: targetDir,
      storedFiles: managedSkill.files,
    });

    if (localEditState.modified && !input.force) {
      skippedLines.push(
        `- ${managedSkill.name} local edits detected in ${localEditState.changedFiles.join(', ')}`,
      );
      continue;
    }

    const snapshot = await fetchRemoteSkillSnapshot({
      ref: managedSkill.ref,
      repo: managedSkill.repo,
      skillPath: managedSkill.path,
    });

    try {
      await replaceManagedSkillDirectory({
        targetDir,
        sourceDir: snapshot.sourceDir,
      });

      const installedFiles = await computeDirectoryHashes(targetDir);

      const updatedSkill = createUpdatedSkillRecord({
        commit: snapshot.commit,
        existingSkill: managedSkill,
        files: installedFiles,
        updatedAt: timestampNow(),
      });

      lockfile = upsertManagedSkill(lockfile, { updatedSkill });
      updatedLines.push(`- ${formatManagedSkillSummary(updatedSkill)}`);
    } finally {
      await snapshot.cleanup();
    }
  }

  await saveSkillsLockfile(context, { lockfile });

  if (updatedLines.length > 0) {
    console.log(
      `Updated ${updatedLines.length} managed skills:\n${updatedLines.join('\n')}`,
    );
  } else {
    console.log('No managed skills were updated.');
  }

  if (skippedLines.length > 0) {
    console.warn(
      `Skipped ${skippedLines.length} managed skills due to local edits. Re-run with --force to overwrite local changes:\n${skippedLines.join('\n')}`,
    );
  }
}
