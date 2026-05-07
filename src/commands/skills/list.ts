import { Effect } from 'effect';

import type { CommandEnv } from '../../lib/command-env.js';
import {
  ensureSkillsRoot,
  findManagedSkill,
  formatManagedSkillSummary,
  listLocalSkillDirectories,
  loadSkillsLockfile,
} from '../../lib/skills.js';

/**
 * Effect program: ensure skills root, load lockfile and local directories, log
 * listing output. Composes with `Effect.runPromise` or `Effect.provide` in
 * tests without involving Commander.
 */
export function skillsListEffect(options: {
  env: CommandEnv;
}): Effect.Effect<void, never, never> {
  const { env } = options;
  const { runtime } = env;

  return Effect.gen(function* () {
    yield* Effect.promise(() => ensureSkillsRoot(env));

    const [localSkillDirectories, lockfile] = yield* Effect.all(
      [
        Effect.promise(() => listLocalSkillDirectories(env)),
        Effect.promise(() => loadSkillsLockfile(env)),
      ],
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
      yield* Effect.sync(() => {
        runtime.logInfo('No local skills found.');
      });
      return;
    }

    yield* Effect.sync(() => {
      runtime.logInfo(outputLines.join('\n'));
    });
  });
}

/**
 * Lists local skills and annotates which ones are managed by the lockfile.
 */
export function runSkillsListCommand(env: CommandEnv): Promise<void> {
  return Effect.runPromise(skillsListEffect({ env }));
}
