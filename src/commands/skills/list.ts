import type { FileSystem } from '@effect/platform/FileSystem';
import { Effect } from 'effect';

import { runCliEffect } from '../../cli/run-effect.js';
import type { CommandEnv } from '../../lib/command-env.js';
import {
  ensureSkillsRoot,
  findManagedSkill,
  formatManagedSkillSummary,
  listLocalSkillDirectories,
  loadSkillsLockfile,
  type LoadSkillsLockfileError,
} from '../../lib/skills.js';
import type {
  EnsureSkillsSourceRootError,
  ListSkillSubdirectoriesError,
} from '../../lib/sync.js';

/**
 * Effect program: ensure skills root, load lockfile and local directories, log
 * listing output. Composes with `Effect.runPromise` or `Effect.provide` in
 * tests without involving Commander.
 */
function skillsListEffect(options: {
  env: CommandEnv;
}): Effect.Effect<
  void,
  | LoadSkillsLockfileError
  | EnsureSkillsSourceRootError
  | ListSkillSubdirectoriesError,
  FileSystem
> {
  const { env } = options;

  return Effect.gen(function* () {
    yield* ensureSkillsRoot(env);

    const [localSkillDirectories, lockfile] = yield* Effect.all(
      [listLocalSkillDirectories(env), loadSkillsLockfile(env)],
      { concurrency: 'unbounded' },
    );

    const localSkillLines = localSkillDirectories.map((skillName) => {
      const managedSkill = findManagedSkill(lockfile, { name: skillName });
      return managedSkill
        ? `- ${formatManagedSkillSummary(managedSkill)}`
        : `- ${skillName} unmanaged`;
    });

    const missingManagedLines = lockfile.skills
      .filter(
        (managedSkill) => !localSkillDirectories.includes(managedSkill.name),
      )
      .map(
        (managedSkill) =>
          `- ${formatManagedSkillSummary(managedSkill)} missing-local-directory`,
      );

    const outputLines = [...localSkillLines, ...missingManagedLines];

    if (outputLines.length === 0) {
      yield* Effect.logInfo('No local skills found.');
      return;
    }

    yield* Effect.logInfo(outputLines.join('\n'));
  });
}

/**
 * Lists local skills and annotates which ones are managed by the lockfile.
 */
export function runSkillsListCommand(env: CommandEnv): Promise<void> {
  return runCliEffect(
    env,
    skillsListEffect({ env }).pipe(Effect.provide(env.runtime.fileSystemLayer)),
  );
}
