import { Effect } from 'effect';

import { runCliEffect } from '../../cli/run-effect.js';
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

type SkillsUpdateAllInput = {
  force: boolean;
};

/**
 * Effect program: load lockfile, update every managed skill (or skip on local
 * edits unless forced), persist the lockfile after each successful skill update,
 * log summaries. Composes with `Effect.runPromise` or `Effect.provide` in tests
 * without involving Commander.
 */
export function skillsUpdateAllEffect(options: {
  env: CommandEnv;
  input: SkillsUpdateAllInput;
}) {
  const { env, input } = options;
  const { context } = env;
  const { force } = input;

  return Effect.gen(function* () {
    let lockfile = yield* loadSkillsLockfile(env);

    if (lockfile.skills.length === 0) {
      yield* Effect.logInfo('No managed skills to update.');
      return;
    }

    const updatedLines: string[] = [];
    const skippedLines: string[] = [];

    for (const managedSkill of lockfile.skills) {
      const targetDir = getManagedSkillDirectory(context, {
        skillName: managedSkill.name,
      });
      const localEditState = yield* detectLocalSkillEdits({
        skillDir: targetDir,
        storedFiles: managedSkill.files,
      });

      if (localEditState.modified && !force) {
        skippedLines.push(
          `- ${managedSkill.name} local edits detected in ${localEditState.changedFiles.join(', ')}`,
        );
        continue;
      }

      const snapshot = yield* fetchRemoteSkillSnapshot({
        ref: managedSkill.ref,
        repo: managedSkill.repo,
        skillPath: managedSkill.path,
      });

      yield* Effect.gen(function* () {
        yield* replaceManagedSkillDirectory({
          sourceDir: snapshot.sourceDir,
          targetDir,
        });

        const installedFiles = yield* computeDirectoryHashes(targetDir);

        const updatedSkill = createUpdatedSkillRecord({
          commit: snapshot.commit,
          existingSkill: managedSkill,
          files: installedFiles,
          updatedAt: timestampNow(),
        });

        lockfile = upsertManagedSkill(lockfile, { updatedSkill });
        updatedLines.push(`- ${formatManagedSkillSummary(updatedSkill)}`);
        yield* saveSkillsLockfile(env, { lockfile });
      }).pipe(
        Effect.ensuring(
          cleanupRemoteSkillSnapshot(snapshot).pipe(
            Effect.catchAll(() => Effect.void),
          ),
        ),
      );
    }

    if (updatedLines.length > 0) {
      yield* Effect.logInfo(
        `Updated ${updatedLines.length} managed skills:\n${updatedLines.join('\n')}`,
      );
    } else {
      yield* Effect.logInfo('No managed skills were updated.');
    }

    if (skippedLines.length > 0) {
      yield* Effect.logWarning(
        `Skipped ${skippedLines.length} managed skills due to local edits. Re-run with --force to overwrite local changes:\n${skippedLines.join('\n')}`,
      );
    }
  });
}

/**
 * Update all managed skills from their tracked remote sources and persist the refreshed skills lockfile.
 *
 * For each managed skill this replaces the local managed directory with the remote snapshot (unless local edits are present and `input.force` is false), recomputes installed file hashes, updates the lockfile record with the new commit and hashes, saves the lockfile after each successful replace, and logs which skills were updated or skipped.
 *
 * @param input.force - When `true`, overwrite local edits; when `false`, skip skills with local modifications
 */
export function runSkillsUpdateAllCommand(
  env: CommandEnv,
  input: SkillsUpdateAllInput,
): Promise<void> {
  return runCliEffect(
    env,
    skillsUpdateAllEffect({ env, input }).pipe(
      Effect.provide(env.runtime.fileSystemLayer),
    ),
  );
}
