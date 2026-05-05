import fs from 'fs-extra';

import type { CommandEnv } from '../../lib/command-env.js';
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
 * Update the lockfile record for a managed skill by recomputing file hashes from its local managed directory.
 *
 * @param env - Command environment providing context and runtime for filesystem and lockfile operations
 * @param input - Input object containing the skill to rehash
 * @param input.skillName - The name of the managed skill to refresh hashes for
 * @throws Error if the managed skill is not present in the lockfile
 * @throws Error if the managed skill's local directory does not exist
 */
export async function runSkillsRehashCommand(
  env: CommandEnv,
  input: {
    skillName: string;
  },
): Promise<void> {
  const { context, runtime } = env;
  const { skillName } = input;
  const lockfile = await loadSkillsLockfile(env);
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

  runtime.logInfo(`Rehashed ${formatManagedSkillSummary(updatedSkill)}`);
}
