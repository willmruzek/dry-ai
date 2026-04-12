import fs from 'fs-extra';
import type { AgentsContext } from '../../lib/context.js';
import {
  cloneRemoteRepo,
  computeDirectoryHashes,
  createImportedSkillRecord,
  ensureSkillsLockfile,
  ensureSkillsRoot,
  findManagedSkill,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  normalizeRemoteRepo,
  replaceManagedSkillDirectory,
  resolveManagedSkillImportPath,
  resolveSkillSourceDir,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Normalizes and de-duplicates requested skill names while preserving their input order.
 */
function normalizeRequestedSkillNames(skillNames: string[]): string[] {
  const uniqueSkillNames: string[] = [];
  const seenSkillNames = new Set<string>();

  for (const rawSkillName of skillNames) {
    const normalizedSkillPath = resolveManagedSkillImportPath({
      skillName: rawSkillName,
    });
    const skillName = normalizedSkillPath.slice('skills/'.length);

    if (seenSkillNames.has(skillName)) {
      continue;
    }

    seenSkillNames.add(skillName);
    uniqueSkillNames.push(skillName);
  }

  return uniqueSkillNames;
}

/**
 * Imports one or more managed skills from a remote repository `skills/` directory into the local skills directory.
 */
export async function runSkillsAddCommand(
  context: AgentsContext,
  input: {
    repo: string;
    skillNames: string[];
    asName: string | undefined;
    pin: boolean;
    ref: string | undefined;
  },
): Promise<void> {
  const repo = normalizeRemoteRepo(input.repo);

  if (input.skillNames.length === 0) {
    throw new Error('At least one skill name must be provided with --skill');
  }

  const requestedSkillNames = normalizeRequestedSkillNames(input.skillNames);

  if (requestedSkillNames.length === 0) {
    throw new Error('At least one skill name must be provided with --skill');
  }

  if (input.asName && requestedSkillNames.length !== 1) {
    throw new Error('--as may only be used when importing exactly one skill');
  }

  await ensureSkillsRoot(context);
  await ensureSkillsLockfile(context);

  let lockfile = await loadSkillsLockfile(context);
  const checkout = await cloneRemoteRepo({
    ref: input.ref,
    repo,
  });
  const skippedSkillNames: string[] = [];
  const importedSkillSummaries: string[] = [];

  try {
    for (const requestedSkillName of requestedSkillNames) {
      const skillName = input.asName ?? requestedSkillName;
      const importedSkillPath = resolveManagedSkillImportPath({
        skillName: requestedSkillName,
      });
      const existingManagedSkill = findManagedSkill(lockfile, {
        name: skillName,
      });

      if (existingManagedSkill) {
        skippedSkillNames.push(skillName);
        continue;
      }

      const targetDir = getManagedSkillDirectory(context, { skillName });

      if (await fs.pathExists(targetDir)) {
        throw new Error(`A local skill directory already exists: ${targetDir}`);
      }

      const sourceDir = await resolveSkillSourceDir({
        checkoutDir: checkout.checkoutDir,
        repo,
        skillName: requestedSkillName,
      });

      await replaceManagedSkillDirectory({
        targetDir,
        sourceDir,
      });

      const installedFiles = await computeDirectoryHashes(targetDir);

      const importedSkill = createImportedSkillRecord({
        commit: checkout.commit,
        files: installedFiles,
        importedAt: timestampNow(),
        name: skillName,
        path: importedSkillPath,
        ref: input.pin ? checkout.commit : input.ref,
        repo,
      });

      lockfile = upsertManagedSkill(lockfile, {
        updatedSkill: importedSkill,
      });
      await saveSkillsLockfile(context, { lockfile });
      importedSkillSummaries.push(formatManagedSkillSummary(importedSkill));
    }
  } finally {
    await checkout.cleanup();
  }

  for (const importedSkillSummary of importedSkillSummaries) {
    console.log(`Imported ${importedSkillSummary}`);
  }

  if (skippedSkillNames.length > 0) {
    console.warn(
      `Skipped already-imported skills: ${skippedSkillNames.join(', ')}`,
    );
  }

  if (importedSkillSummaries.length === 0) {
    console.log('No skills were imported.');
  }
}
