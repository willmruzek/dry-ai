import { Effect } from 'effect';

import type { CommandEnv } from '../../lib/command-env.js';
import {
  cleanupRemoteSkillSnapshot,
  computeDirectoryHashes,
  createUpdatedSkillRecord,
  detectLocalSkillEdits,
  fetchRemoteSkillSnapshot,
  findManagedSkill,
  formatManagedSkillSummary,
  getManagedSkillDirectory,
  loadSkillsLockfile,
  managedSkillNotFoundMessage,
  replaceManagedSkillDirectory,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
} from '../../lib/skills.js';

type SkillsUpdateInput = {
  force: boolean;
  skillName: string;
};

/**
 * Effect program: load lockfile, optionally skip on local edits, fetch remote
 * snapshot, replace directory, save lockfile, log success, and clean up the
 * snapshot. Composes with `Effect.runPromise` or `Effect.provide` in tests
 * without involving Commander.
 */
export function skillsUpdateEffect(options: {
  env: CommandEnv;
  input: SkillsUpdateInput;
}): Effect.Effect<void, never, never> {
  const { env, input } = options;
  const { context, runtime } = env;
  const { force, skillName } = input;

  return Effect.gen(function* () {
    const lockfile = yield* Effect.promise(() => loadSkillsLockfile(env));
    const managedSkill = findManagedSkill(lockfile, { name: skillName });

    if (!managedSkill) {
      throw new Error(managedSkillNotFoundMessage(skillName));
    }

    const targetDir = getManagedSkillDirectory(context, { skillName });
    const localEditState = yield* Effect.promise(() =>
      detectLocalSkillEdits(env, {
        skillDir: targetDir,
        storedFiles: managedSkill.files,
      }),
    );

    if (localEditState.modified && !force) {
      yield* Effect.sync(() => {
        runtime.logWarn(
          `Skipped ${skillName} because local edits were detected in: ${localEditState.changedFiles.join(', ')}. Re-run with --force to overwrite local changes.`,
        );
      });
      return;
    }

    const snapshot = yield* Effect.promise(() =>
      fetchRemoteSkillSnapshot(env, {
        ref: managedSkill.ref,
        repo: managedSkill.repo,
        skillPath: managedSkill.path,
      }),
    );

    yield* Effect.promise(async () => {
      try {
        await replaceManagedSkillDirectory(env, {
          sourceDir: snapshot.sourceDir,
          targetDir,
        });

        const installedFiles = await computeDirectoryHashes(env, targetDir);

        const updatedSkill = createUpdatedSkillRecord({
          commit: snapshot.commit,
          existingSkill: managedSkill,
          files: installedFiles,
          updatedAt: timestampNow(),
        });

        await saveSkillsLockfile(env, {
          lockfile: upsertManagedSkill(lockfile, { updatedSkill }),
        });

        runtime.logInfo(`Updated ${formatManagedSkillSummary(updatedSkill)}`);
      } finally {
        await cleanupRemoteSkillSnapshot(snapshot);
      }
    });
  });
}

/**
 * Updates one managed skill from its tracked remote source and refreshes the lockfile.
 */
export function runSkillsUpdateCommand(
  env: CommandEnv,
  input: SkillsUpdateInput,
): Promise<void> {
  return Effect.runPromise(skillsUpdateEffect({ env, input }));
}
