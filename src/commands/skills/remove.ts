import type { FileSystem } from '@effect/platform/FileSystem';
import { Effect } from 'effect';

import type { CommandEnv } from '../../lib/command-env.js';
import {
  type LoadSkillsLockfileError,
  findManagedSkill,
  formatManagedSkillSummary,
  loadSkillsLockfile,
  managedSkillNotFoundMessage,
  ManagedSkillNotFoundError,
  removeManagedSkill,
  removeManagedSkillDirectory,
  saveSkillsLockfile,
} from '../../lib/skills.js';

type SkillsRemoveInput = {
  skillName: string;
};

/**
 * Effect program: load the lockfile, persist the entry removal, remove the
 * managed skill directory from disk, then log success. Lockfile is saved before
 * directory removal so a failed write cannot leave the lockfile referencing a
 * deleted path. Composes with `Effect.runPromise` or `Effect.provide` in tests
 * without involving Commander.
 */
export function skillsRemoveEffect(options: {
  env: CommandEnv;
  input: SkillsRemoveInput;
}): Effect.Effect<
  void,
  LoadSkillsLockfileError | ManagedSkillNotFoundError,
  FileSystem
> {
  const { env, input } = options;
  const { runtime } = env;
  const { skillName } = input;

  return Effect.gen(function* () {
    const lockfile = yield* loadSkillsLockfile(env);
    const managedSkill = findManagedSkill(lockfile, { name: skillName });

    if (!managedSkill) {
      return yield* new ManagedSkillNotFoundError({
        message: managedSkillNotFoundMessage(skillName),
      });
    }

    const updatedLockfile = removeManagedSkill(lockfile, { name: skillName });

    yield* saveSkillsLockfile(env, { lockfile: updatedLockfile });

    yield* removeManagedSkillDirectory(env, { skillName });

    yield* Effect.sync(() => {
      runtime.logInfo(`Removed ${formatManagedSkillSummary(managedSkill)}`);
    });
  });
}

/**
 * Removes a managed skill: persists lockfile changes, then deletes its directory.
 */
export function runSkillsRemoveCommand(
  env: CommandEnv,
  input: SkillsRemoveInput,
): Promise<void> {
  return Effect.runPromise(
    skillsRemoveEffect({ env, input }).pipe(
      Effect.provide(env.runtime.fileSystemLayer),
    ),
  );
}
