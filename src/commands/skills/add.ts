import type { FileSystem } from '@effect/platform/FileSystem';
import { Effect } from 'effect';

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
  type LoadSkillsLockfileError,
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
}): Effect.Effect<void, LoadSkillsLockfileError | Error, FileSystem> {
  const { env, input } = options;
  const { context, runtime } = env;

  return Effect.gen(function* () {
    const repo = normalizeRemoteRepo(input.repo);
    const normalizedBasePath = normalizeImportedSkillPath(input.repoPath);

    if (input.skillNames.length === 0) {
      throw new Error('At least one skill name must be provided with --skill');
    }

    const requestedSkillNames = normalizeRequestedSkillNames(input.skillNames);

    if (input.asName && requestedSkillNames.length !== 1) {
      throw new Error('--as may only be used when importing exactly one skill');
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
          throw new Error(
            `A local skill directory already exists: ${targetDir}`,
          );
        }

        const sourceDir = yield* resolveSkillSourceDirByPath({
          checkoutDir: checkout.checkoutDir,
          repo,
          skillPath: importedSkillPath,
        });

        yield* replaceManagedSkillDirectory({
          targetDir,
          sourceDir,
        });

        const installedFiles = yield* computeDirectoryHashes(targetDir);

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
        yield* saveSkillsLockfile(env, { lockfile });
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
      yield* Effect.sync(() => {
        runtime.logInfo(`Imported ${importedSkillSummary}`);
      });
    }

    if (skippedSkillNames.length > 0) {
      yield* Effect.sync(() => {
        runtime.logWarn(
          `Skipped already-imported skills: ${skippedSkillNames.join(', ')}`,
        );
      });
    }

    if (importedSkillSummaries.length === 0) {
      yield* Effect.sync(() => {
        runtime.logInfo('No skills were imported.');
      });
    }
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
 * @throws Error - If `--skill` is omitted or `--skill` produces no names after CLI parsing
 * @throws Error - If `--as` is provided while importing more than one skill
 * @throws Error - If a target local skill directory already exists for an import
 */
export function runSkillsAddCommand(
  env: CommandEnv,
  input: SkillsAddInput,
): Promise<void> {
  return Effect.runPromise(
    skillsAddEffect({ env, input }).pipe(
      Effect.provide(env.runtime.fileSystemLayer),
    ),
  );
}
