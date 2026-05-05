import type { CommandEnv } from '../../lib/command-env.js';
import {
  cleanupRemoteSkillSnapshot,
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
 * Update all managed skills from their tracked remote sources and persist the refreshed skills lockfile.
 *
 * For each managed skill this replaces the local managed directory with the remote snapshot (unless local edits are present and `input.force` is false), recomputes installed file hashes, updates the lockfile record with the new commit and hashes, saves the lockfile, and logs which skills were updated or skipped.
 *
 * @param input.force - When `true`, overwrite local edits; when `false`, skip skills with local modifications
 */
export async function runSkillsUpdateAllCommand(
  env: CommandEnv,
  input: {
    force: boolean;
  },
): Promise<void> {
  const { context, runtime } = env;
  let lockfile = await loadSkillsLockfile(env);

  if (lockfile.skills.length === 0) {
    runtime.logInfo('No managed skills to update.');
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
      await cleanupRemoteSkillSnapshot(snapshot);
    }
  }

  await saveSkillsLockfile(context, { lockfile });

  if (updatedLines.length > 0) {
    runtime.logInfo(
      `Updated ${updatedLines.length} managed skills:\n${updatedLines.join('\n')}`,
    );
  } else {
    runtime.logInfo('No managed skills were updated.');
  }

  if (skippedLines.length > 0) {
    runtime.logWarn(
      `Skipped ${skippedLines.length} managed skills due to local edits. Re-run with --force to overwrite local changes:\n${skippedLines.join('\n')}`,
    );
  }
}
