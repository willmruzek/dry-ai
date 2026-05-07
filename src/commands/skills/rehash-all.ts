import type { CommandEnv } from '../../lib/command-env.js';
import {
  computeDirectoryHashes,
  createUpdatedSkillRecord,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  pathExistsInFileSystem,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Refreshes the stored file hashes for every managed skill using current local directory contents.
 *
 * Recomputes file hashes for each managed skill found locally, updates the skills lockfile with the new file records, and persists the lockfile. Skills whose local directory is missing are skipped and reported via runtime logs.
 */
export async function runSkillsRehashAllCommand(
  env: CommandEnv,
): Promise<void> {
  const { context, runtime } = env;
  let lockfile = await loadSkillsLockfile(env);

  if (lockfile.skills.length === 0) {
    runtime.logInfo('No managed skills to rehash.');
    return;
  }

  const rehashedLines: string[] = [];
  const skippedLines: string[] = [];

  for (const managedSkill of lockfile.skills) {
    const targetDir = getManagedSkillDirectory(context, {
      skillName: managedSkill.name,
    });

    if (!(await pathExistsInFileSystem(env, targetDir))) {
      skippedLines.push(
        `- ${formatManagedSkillSummary(managedSkill)} missing-local-directory`,
      );
      continue;
    }

    const installedFiles = await computeDirectoryHashes(env, targetDir);
    const updatedSkill = createUpdatedSkillRecord({
      commit: managedSkill.commit,
      existingSkill: managedSkill,
      files: installedFiles,
      updatedAt: timestampNow(),
    });

    lockfile = upsertManagedSkill(lockfile, { updatedSkill });
    rehashedLines.push(`- ${formatManagedSkillSummary(updatedSkill)}`);
  }

  await saveSkillsLockfile(env, { lockfile });

  if (rehashedLines.length > 0) {
    runtime.logInfo(
      `Rehashed ${rehashedLines.length} managed skills:\n${rehashedLines.join('\n')}`,
    );
  } else {
    runtime.logInfo('No managed skills were rehashed.');
  }

  if (skippedLines.length > 0) {
    runtime.logWarn(
      `Skipped ${skippedLines.length} managed skills because the local directory is missing:\n${skippedLines.join('\n')}`,
    );
  }
}
