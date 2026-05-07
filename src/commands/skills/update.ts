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
  ManagedSkillNotFoundError,
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
}) {
  const { env, input } = options;
  const { context, runtime } = env;
  const { force, skillName } = input;

  return Effect.gen(function* () {
    const lockfile = yield* loadSkillsLockfile(env);
    const managedSkill = findManagedSkill(lockfile, { name: skillName });

    if (!managedSkill) {
      return yield* new ManagedSkillNotFoundError({
        message: managedSkillNotFoundMessage(skillName),
      });
    }

    const targetDir = getManagedSkillDirectory(context, { skillName });
    const localEditState = yield* detectLocalSkillEdits({
      skillDir: targetDir,
      storedFiles: managedSkill.files,
    });

    if (localEditState.modified && !force) {
      yield* Effect.sync(() => {
        runtime.logWarn(
          `Skipped ${skillName} because local edits were detected in: ${localEditState.changedFiles.join(', ')}. Re-run with --force to overwrite local changes.`,
        );
      });
      return;
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

      yield* saveSkillsLockfile(env, {
        lockfile: upsertManagedSkill(lockfile, { updatedSkill }),
      });

      yield* Effect.sync(() => {
        runtime.logInfo(`Updated ${formatManagedSkillSummary(updatedSkill)}`);
      });
    }).pipe(
      Effect.ensuring(
        cleanupRemoteSkillSnapshot(snapshot).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );
  });
}

/**
 * Updates one managed skill from its tracked remote source and refreshes the lockfile.
 */
export function runSkillsUpdateCommand(
  env: CommandEnv,
  input: SkillsUpdateInput,
): Promise<void> {
  return Effect.runPromise(
    skillsUpdateEffect({ env, input }).pipe(
      Effect.provide(env.runtime.fileSystemLayer),
    ),
  );
}
