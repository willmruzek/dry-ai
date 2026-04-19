import fs from 'fs-extra';
import type { CommandEnv } from '../../cli.js';
import {
  cleanupRemoteRepoCheckout,
  cloneRemoteRepo,
  computeDirectoryHashes,
  createImportedSkillRecord,
  deriveSkillName,
  ensureSkillsLockfile,
  ensureSkillsRoot,
  findManagedSkill,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  normalizeImportedSkillPath,
  normalizeRemoteRepo,
  replaceManagedSkillDirectory,
  resolveManagedSkillImportPath,
  resolveManagedSkillImportPathFromBase,
  resolveSkillSourceDirByPath,
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
 * Returns the resolved repository-relative import path for a single requested skill.
 *
 * @example
 * // No base path — defaults to the repository `skills/` directory
 * resolveRequestedImportPath({ basePath: undefined, requestedSkillName: 'my-skill' });
 * // → 'skills/my-skill'
 *
 * @example
 * // With a base path — skill is resolved relative to that directory
 * resolveRequestedImportPath({ basePath: 'tools', requestedSkillName: 'my-skill' });
 * // → 'tools/my-skill'
 *
 * @example
 * // Base path of '.' — skill is resolved from the repository root
 * resolveRequestedImportPath({ basePath: '.', requestedSkillName: 'my-skill' });
 * // → 'my-skill'
 */
function resolveRequestedImportPath(input: {
  basePath: string | undefined;
  requestedSkillName: string;
}): string {
  const importPath = resolveManagedSkillImportPathFromBase({
    basePath: input.basePath,
    skillName: input.requestedSkillName,
  });

  return normalizeImportedSkillPath(importPath) ?? importPath;
}

/**
 * Imports one or more managed skills from a remote repository into the local skills directory.
 */
export async function runSkillsAddCommand(
  env: CommandEnv,
  input: {
    repo: string;
    repoPath: string | undefined;
    skillNames: string[];
    asName: string | undefined;
    pin: boolean;
    ref: string | undefined;
  },
): Promise<void> {
  const { context, runtime } = env;
  const repo = normalizeRemoteRepo(input.repo);
  const normalizedBasePath = normalizeImportedSkillPath(input.repoPath);

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
      const importedSkillPath = resolveRequestedImportPath({
        basePath: normalizedBasePath,
        requestedSkillName,
      });
      const skillName = deriveSkillName({
        repo,
        skillPath: importedSkillPath,
        explicitName: input.asName,
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

      const sourceDir = await resolveSkillSourceDirByPath({
        checkoutDir: checkout.checkoutDir,
        repo,
        skillPath: importedSkillPath,
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
    await cleanupRemoteRepoCheckout(checkout);
  }

  for (const importedSkillSummary of importedSkillSummaries) {
    runtime.logInfo(`Imported ${importedSkillSummary}`);
  }

  if (skippedSkillNames.length > 0) {
    runtime.logWarn(
      `Skipped already-imported skills: ${skippedSkillNames.join(', ')}`,
    );
  }

  if (importedSkillSummaries.length === 0) {
    runtime.logInfo('No skills were imported.');
  }
}
