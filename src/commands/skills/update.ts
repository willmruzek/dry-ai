import type { AgentsContext } from '../../lib/context.js';
import {
  computeDirectoryHashes,
  createUpdatedSkillRecord,
  detectLocalSkillEdits,
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
    force: boolean;
    skillName: string;
  },
): Promise<void> {
  const { force, skillName } = input;

  const lockfile = await loadSkillsLockfile(context);
  const managedSkill = findManagedSkill(lockfile, { name: skillName });

  if (!managedSkill) {
    throw new Error(`Managed skill not found: ${skillName}`);
  }

  const targetDir = getManagedSkillDirectory(context, { skillName });
  const localEditState = await detectLocalSkillEdits({
    skillDir: targetDir,
    storedFiles: managedSkill.files,
  });

  if (localEditState.modified && !force) {
    console.warn(
      `Skipped ${skillName} because local edits were detected in: ${localEditState.changedFiles.join(', ')}. Re-run with --force to overwrite local changes.`,
    );
    return;
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

    await saveSkillsLockfile(context, {
      lockfile: upsertManagedSkill(lockfile, { updatedSkill }),
    });

    console.log(`Updated ${formatManagedSkillSummary(updatedSkill)}`);
  } finally {
    await snapshot.cleanup();
  }
}
