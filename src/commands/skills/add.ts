import { Data, Effect } from 'effect';

import { runCliEffect } from '../../cli/run-effect.js';
import type { CommandEnv } from '../../lib/command-env.js';
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
  pathExistsInFileSystem,
  replaceManagedSkillDirectory,
  resolveManagedSkillImportPath,
  resolveManagedSkillImportPathFromBase,
  resolveSkillSourceDirByPath,
  saveSkillsLockfile,
  timestampNow,
  upsertManagedSkill,
  removeManagedSkillDirectory,
} from '../../lib/skills.js';

/**
 * Error representing invalid `skills add` arguments or import preconditions
 * (before remote fetch or install).
 */
export class SkillsAddValidationError extends Data.TaggedError(
  'SkillsAddValidationError',
)<{
  readonly reason:
    | 'no_skills'
    | 'as_requires_single_skill'
    | 'target_skill_directory_exists';
  readonly targetDir?: string;
}> {
  override get message(): string {
    switch (this.reason) {
      case 'no_skills':
        return 'At least one skill name must be provided with --skill';
      case 'as_requires_single_skill':
        return '--as may only be used when importing exactly one skill';
      case 'target_skill_directory_exists':
        return `A local skill directory already exists: ${this.targetDir ?? ''}`;
    }
  }
}

/**
 * Error representing failure to persist the skills lockfile after `skills add`
 * already wrote the skill under {@link targetDir}.
 */
export class SkillsAddLockfilePersistAfterInstallError extends Data.TaggedError(
  'SkillsAddLockfilePersistAfterInstallError',
)<{
  readonly targetDir: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to persist skills lockfile after installing to ${this.targetDir} (installed files removal was attempted)`;
  }
}

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

  return normalizeImportedSkillPath(importPath)!;
}

type SkillsAddInput = {
  repo: string;
  repoPath: string | undefined;
  skillNames: string[];
  asName: string | undefined;
  pin: boolean;
  ref: string | undefined;
};

/**
 * Effect program: validate input, ensure roots/lockfile, clone remote, import
 * each requested skill (or skip), persist lockfile per import, clean up
 * checkout, then log. Composes with `Effect.runPromise` or `Effect.provide` in
 * tests without involving Commander.
 */
export function skillsAddEffect(options: {
  env: CommandEnv;
  input: SkillsAddInput;
}) {
  const { env, input } = options;
  const { context } = env;

  return Effect.gen(function* () {
    const repo = normalizeRemoteRepo(input.repo);
    const normalizedBasePath = normalizeImportedSkillPath(input.repoPath);

    if (input.skillNames.length === 0) {
      return yield* new SkillsAddValidationError({ reason: 'no_skills' });
    }

    const requestedSkillNames = normalizeRequestedSkillNames(input.skillNames);

    if (input.asName && requestedSkillNames.length !== 1) {
      return yield* new SkillsAddValidationError({
        reason: 'as_requires_single_skill',
      });
    }

    yield* ensureSkillsRoot(env);
    yield* ensureSkillsLockfile(env);

    let lockfile = yield* loadSkillsLockfile(env);
    const checkout = yield* cloneRemoteRepo({
      ref: input.ref,
      repo,
    });
    const skippedSkillNames: string[] = [];
    const importedSkillSummaries: string[] = [];

    yield* Effect.gen(function* () {
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

        if (yield* pathExistsInFileSystem(targetDir)) {
          return yield* new SkillsAddValidationError({
            reason: 'target_skill_directory_exists',
            targetDir,
          });
        }

        const sourceDir = yield* resolveSkillSourceDirByPath({
          checkoutDir: checkout.checkoutDir,
          repo,
          skillPath: importedSkillPath,
        });

        const installedFiles = yield* computeDirectoryHashes(sourceDir);

        const importedSkill = createImportedSkillRecord({
          commit: checkout.commit,
          files: installedFiles,
          importedAt: timestampNow(),
          name: skillName,
          path: importedSkillPath,
          ref: input.pin ? checkout.commit : input.ref,
          repo,
        });

        yield* replaceManagedSkillDirectory({
          targetDir,
          sourceDir,
        });

        const lockfileWithNewSkill = upsertManagedSkill(lockfile, {
          updatedSkill: importedSkill,
        });

        yield* saveSkillsLockfile(env, { lockfile: lockfileWithNewSkill }).pipe(
          Effect.catchAll((saveFailure) =>
            Effect.gen(function* () {
              yield* removeManagedSkillDirectory(env, { skillName }).pipe(
                Effect.catchAll(() => Effect.void),
              );
              return yield* new SkillsAddLockfilePersistAfterInstallError({
                targetDir,
                cause: saveFailure,
              });
            }),
          ),
        );

        lockfile = lockfileWithNewSkill;

        importedSkillSummaries.push(formatManagedSkillSummary(importedSkill));
      }
    }).pipe(
      Effect.ensuring(
        cleanupRemoteRepoCheckout(checkout).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );

    for (const importedSkillSummary of importedSkillSummaries) {
      yield* Effect.logInfo(`Imported ${importedSkillSummary}`);
    }

    if (skippedSkillNames.length > 0) {
      yield* Effect.logWarning(
        `Skipped already-imported skills: ${skippedSkillNames.join(', ')}`,
      );
    }

    if (importedSkillSummaries.length === 0) {
      yield* Effect.logInfo('No skills were imported.');
    }
    return;
  });
}

/**
 * Import one or more managed skills from a remote repository into the local skills directory and update the skills lockfile.
 *
 * @param env - Runtime environment providing contextual services (context and runtime)
 * @param repo - Remote repository identifier (e.g., remote URL or shortcut) to import from
 * @param repoPath - Optional path within the remote repository that contains the skills (may be undefined)
 * @param skillNames - List of requested skill names or import specifiers to import
 * @param asName - Optional explicit local name to assign to the imported skill; may only be used when importing exactly one skill
 * @param pin - If true, record the imported skill at the specific commit; otherwise record the provided ref
 * @param ref - Optional branch, tag, or commit-ish to check out from the remote repository
 *
 * @throws SkillsAddValidationError - If `--skill` is omitted or `--skill` produces no names after CLI parsing
 * @throws SkillsAddValidationError - If `--as` is provided while importing more than one skill
 * @throws SkillsAddValidationError - If a target local skill directory already exists for an import
 */
export function runSkillsAddCommand(
  env: CommandEnv,
  input: SkillsAddInput,
): Promise<void> {
  return runCliEffect(
    env,
    skillsAddEffect({ env, input }).pipe(
      Effect.provide(env.runtime.fileSystemLayer),
    ),
  );
}
