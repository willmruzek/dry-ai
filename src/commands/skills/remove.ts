import type { FileSystem } from '@effect/platform/FileSystem';
import { Effect } from 'effect';

import type { CommandEnv } from '../../lib/command-env.js';
import {
  type LoadSkillsLockfileError,
  findManagedSkill,
  formatManagedSkillSummary,
  loadSkillsLockfile,
  managedSkillNotFoundMessage,
  removeManagedSkill,
  removeManagedSkillDirectory,
  saveSkillsLockfile,
} from '../../lib/skills.js';

type SkillsRemoveInput = {
  skillName: string;
};

/**
 * Effect program: load the lockfile, remove the managed skill directory, save
 * the lockfile, and log success. Composes with `Effect.runPromise` or
 * `Effect.provide` in tests without involving Commander.
 */
export function skillsRemoveEffect(options: {
  env: CommandEnv;
  input: SkillsRemoveInput;
}): Effect.Effect<void, LoadSkillsLockfileError, FileSystem> {
  const { env, input } = options;
  const { runtime } = env;
  const { skillName } = input;

  return Effect.gen(function* () {
    const lockfile = yield* loadSkillsLockfile(env);
    const managedSkill = findManagedSkill(lockfile, { name: skillName });

    if (managedSkill === undefined) {
      throw new Error(managedSkillNotFoundMessage(skillName));
    }

    yield* removeManagedSkillDirectory(env, { skillName });

    yield* saveSkillsLockfile(env, {
      lockfile: removeManagedSkill(lockfile, { name: skillName }),
    });

    yield* Effect.sync(() => {
      runtime.logInfo(`Removed ${formatManagedSkillSummary(managedSkill)}`);
    });
  });
}

/**
 * Removes a managed skill from the local directory and updates the lockfile.
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
