import fs from 'fs-extra';
import type { AgentsContext } from '../../lib/context.js';
import {
  createImportedSkillRecord,
  deriveSkillName,
  ensureSkillsLockfile,
  ensureSkillsRoot,
  fetchRemoteSkillSnapshot,
  findManagedSkill,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  normalizeImportedSkillPath,
  normalizeRemoteRepo,
  replaceManagedSkillDirectory,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

/**
 * Imports a managed skill from a remote repository into the local skills directory.
 */
export async function runSkillsImportCommand(
  context: AgentsContext,
  input: {
    repo: string;
    skillPath: string | undefined;
    asName: string | undefined;
    pin: boolean;
    ref: string | undefined;
  },
): Promise<void> {
  const repo = normalizeRemoteRepo(input.repo);
  const importedSkillPath = normalizeImportedSkillPath(input.skillPath);
  const skillName = deriveSkillName({
    repo,
    skillPath: importedSkillPath,
    explicitName: input.asName,
  });
  const requestedRef = input.ref;

  await ensureSkillsRoot(context);
  await ensureSkillsLockfile(context);

  const existingLockfile = await loadSkillsLockfile(context);
  const existingManagedSkill = findManagedSkill(existingLockfile, {
    name: skillName,
  });

  if (existingManagedSkill) {
    throw new Error(
      `A managed skill already exists with that name: ${skillName}`,
    );
  }

  const targetDir = getManagedSkillDirectory(context, { skillName });

  if (await fs.pathExists(targetDir)) {
    throw new Error(`A local skill directory already exists: ${targetDir}`);
  }

  const snapshot = await fetchRemoteSkillSnapshot({
    ref: requestedRef,
    repo,
    skillPath: importedSkillPath,
  });

  try {
    await replaceManagedSkillDirectory({
      targetDir,
      sourceDir: snapshot.sourceDir,
    });
  } finally {
    await snapshot.cleanup();
  }

  const importedAt = timestampNow();
  const trackedRef = input.pin ? snapshot.commit : requestedRef;
  const importedSkill = createImportedSkillRecord({
    commit: snapshot.commit,
    importedAt,
    name: skillName,
    path: importedSkillPath,
    ref: trackedRef,
    repo,
  });
  const updatedLockfile = upsertManagedSkill(existingLockfile, {
    updatedSkill: importedSkill,
  });

  await saveSkillsLockfile(context, { lockfile: updatedLockfile });

  console.log(`Imported ${formatManagedSkillSummary(importedSkill)}`);
}
