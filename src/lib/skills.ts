import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { FileSystem } from '@effect/platform/FileSystem';
import { Data, Effect, Schema } from 'effect';
import * as ParseResult from 'effect/ParseResult';
import fs from 'fs-extra';
import { simpleGit } from 'simple-git';

import type { CommandEnv } from './command-env.js';
import type { AgentsContext } from './context.js';

/** Subset of {@link CommandEnv} used to load the skills lockfile via Effect `FileSystem`. */
export type SkillsLockfileEnv = Pick<CommandEnv, 'context' | 'runtime'>;

const ManagedSkillFiles = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

const SkillLockEntry = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  repo: Schema.String.pipe(Schema.minLength(1)),
  path: Schema.String.pipe(Schema.minLength(1)),
  ref: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  commit: Schema.String.pipe(Schema.minLength(1)),
  files: Schema.optional(ManagedSkillFiles),
  importedAt: Schema.String, // tighten with a DateTime schema if you want stricter ISO checks
  updatedAt: Schema.String,
});

const SkillsLockfile = Schema.Struct({
  version: Schema.Literal(1),
  skills: Schema.Array(SkillLockEntry),
}).pipe(
  Schema.filterEffect((lockfile) => {
    const seen = new Set<string>();
    for (const [index, skill] of lockfile.skills.entries()) {
      if (seen.has(skill.name)) {
        return Effect.succeed({
          path: ['skills', index, 'name'],
          message: `Duplicate managed skill name: ${skill.name}`,
        });
      }
      seen.add(skill.name);
    }
    return Effect.succeed(true);
  }),
);

class InvalidSkillsLockfile extends Data.TaggedError('InvalidSkillsLockfile')<{
  readonly message: string;
  readonly lockfilePath: string;
  readonly cause: ParseResult.ParseError;
}> {}

export type ManagedSkill = Schema.Schema.Type<typeof SkillLockEntry>;
export type SkillsLockfile = Schema.Schema.Type<typeof SkillsLockfile>;
export type ManagedSkillFiles = Schema.Schema.Type<typeof ManagedSkillFiles>;

export type RemoteSkillSnapshot = {
  cleanup: () => Promise<void>;
  commit: string;
  sourceDir: string;
};

export type RemoteRepoCheckout = {
  checkoutDir: string;
  cleanup: () => Promise<void>;
  commit: string;
};

export function createEmptySkillsLockfile(): SkillsLockfile {
  return {
    version: 1,
    skills: [],
  };
}

export async function ensureSkillsRoot(context: AgentsContext): Promise<void> {
  await fs.ensureDir(context.sourceRoots.skills);
}

/**
 * Ensure a skills lockfile exists at the path defined in `context`, creating and saving an empty lockfile when it is missing.
 *
 * @param context - Execution context containing `skillsLockfilePath` and filesystem access used to read/write the lockfile
 */
export async function ensureSkillsLockfile(
  context: AgentsContext,
): Promise<void> {
  if (await fs.pathExists(context.skillsLockfilePath)) {
    return;
  }

  await saveSkillsLockfile(context, { lockfile: createEmptySkillsLockfile() });
}

/**
 * Load the repository's skills lockfile, validate it against the schema, and return a sorted lockfile object.
 *
 * @param env - Environment containing `context` (with `skillsLockfilePath`) and `runtime` (providing the filesystem layer) used to locate and read the lockfile.
 * @returns The decoded and lexicographically sorted `SkillsLockfile`.
 * @throws {InvalidSkillsLockfile} When a lockfile exists but fails schema parsing/validation.
 */
export async function loadSkillsLockfile(
  env: SkillsLockfileEnv,
): Promise<SkillsLockfile> {
  const {
    context,
    runtime: { fileSystemLayer },
  } = env;

  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      if (!(yield* fs.exists(context.skillsLockfilePath))) {
        return createEmptySkillsLockfile();
      }

      const rawLockfile = yield* fs.readFileString(context.skillsLockfilePath);

      const decoded = yield* Schema.decodeUnknown(
        Schema.parseJson(SkillsLockfile),
      )(rawLockfile).pipe(
        Effect.mapError(
          (parseError) =>
            new InvalidSkillsLockfile({
              lockfilePath: context.skillsLockfilePath,
              message: `Invalid skills lockfile at ${context.skillsLockfilePath}:\n${ParseResult.TreeFormatter.formatErrorSync(parseError)}`,
              cause: parseError,
            }),
        ),
      );

      return sortSkillsLockfile(decoded);
    }).pipe(Effect.provide(fileSystemLayer)),
  );
}

export async function saveSkillsLockfile(
  context: AgentsContext,
  { lockfile }: { lockfile: SkillsLockfile },
): Promise<void> {
  const normalizedLockfile = sortSkillsLockfile(lockfile);
  await fs.writeFile(
    context.skillsLockfilePath,
    `${JSON.stringify(normalizedLockfile, null, 2)}\n`,
    'utf8',
  );
}

export function findManagedSkill(
  lockfile: SkillsLockfile,
  { name }: { name: string },
): ManagedSkill | undefined {
  return lockfile.skills.find((skill) => skill.name === name);
}

export function upsertManagedSkill(
  lockfile: SkillsLockfile,
  { updatedSkill }: { updatedSkill: ManagedSkill },
): SkillsLockfile {
  const remainingSkills = lockfile.skills.filter(
    (skill) => skill.name !== updatedSkill.name,
  );

  return sortSkillsLockfile({
    version: lockfile.version,
    skills: [...remainingSkills, updatedSkill],
  });
}

export function removeManagedSkill(
  lockfile: SkillsLockfile,
  { name }: { name: string },
): SkillsLockfile {
  return sortSkillsLockfile({
    version: lockfile.version,
    skills: lockfile.skills.filter((skill) => skill.name !== name),
  });
}

export async function listLocalSkillDirectories(
  context: AgentsContext,
): Promise<string[]> {
  await ensureSkillsRoot(context);
  const entries = await fs.readdir(context.sourceRoots.skills, {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export function getManagedSkillDirectory(
  context: AgentsContext,
  { skillName }: { skillName: string },
): string {
  return path.join(context.sourceRoots.skills, skillName);
}

export function deriveSkillName({
  repo,
  skillPath,
  explicitName,
}: {
  repo: string;
  skillPath: string;
  explicitName: string | undefined;
}): string {
  const candidateName =
    explicitName ?? inferDefaultSkillName({ repo, skillPath });

  if (
    candidateName.length === 0 ||
    candidateName === '.' ||
    candidateName === '..' ||
    candidateName.includes('/') ||
    candidateName.includes('\\')
  ) {
    throw new Error(`Invalid skill name: ${candidateName}`);
  }

  return candidateName;
}

export function normalizeRemoteRepo(repo: string): string {
  const trimmedRepo = repo.trim();

  if (trimmedRepo.length === 0) {
    throw new Error('Repository may not be empty');
  }

  if (githubRepoShorthandPattern.test(trimmedRepo)) {
    const [owner, rawRepoName] = trimmedRepo.split('/');
    const repoName = rawRepoName.endsWith('.git')
      ? rawRepoName.slice(0, -4)
      : rawRepoName;

    return `https://github.com/${owner}/${repoName}.git`;
  }

  return trimmedRepo;
}

/**
 * Returns the canonical remote path for a managed skill under the repository `skills/` directory.
 */
export function resolveManagedSkillImportPath({
  skillName,
}: {
  skillName: string;
}): string {
  const trimmedSkillName = skillName.trim();

  if (
    trimmedSkillName.length === 0 ||
    trimmedSkillName === '.' ||
    trimmedSkillName === '..' ||
    trimmedSkillName.includes('/') ||
    trimmedSkillName.includes('\\')
  ) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }

  return `skills/${trimmedSkillName}`;
}

/**
 * Normalizes an explicitly provided repository-relative skill path.
 */
export function normalizeImportedSkillPath(
  skillPath: string | undefined,
): string | undefined {
  if (skillPath === undefined) {
    return undefined;
  }

  return path.normalize(skillPath);
}

/**
 * Joins an optional base repository path with a requested managed skill name.
 */
export function resolveManagedSkillImportPathFromBase(input: {
  basePath: string | undefined;
  skillName: string;
}): string {
  const normalizedBasePath = normalizeImportedSkillPath(input.basePath);
  const defaultSkillPath = resolveManagedSkillImportPath({
    skillName: input.skillName,
  });

  if (normalizedBasePath === '.') {
    return path.normalize(input.skillName);
  }

  if (normalizedBasePath === undefined) {
    return defaultSkillPath;
  }

  return path.normalize(path.join(normalizedBasePath, input.skillName));
}

/**
 * Creates the lockfile record for a newly imported managed skill.
 */
export function createImportedSkillRecord(input: {
  commit: string;
  files: ManagedSkillFiles;
  importedAt: string;
  name: string;
  path: string;
  ref: string | undefined;
  repo: string;
}): ManagedSkill {
  return {
    commit: input.commit,
    files: input.files,
    importedAt: input.importedAt,
    name: input.name,
    path: input.path,
    ref: input.ref,
    repo: input.repo,
    updatedAt: input.importedAt,
  };
}

/**
 * Returns an updated lockfile record for an existing managed skill after a successful remote refresh.
 */
export function createUpdatedSkillRecord(input: {
  commit: string;
  existingSkill: ManagedSkill;
  files: ManagedSkillFiles;
  updatedAt: string;
}): ManagedSkill {
  return {
    ...input.existingSkill,
    commit: input.commit,
    files: input.files,
    updatedAt: input.updatedAt,
  };
}

/**
 * Returns a map of relative file path → SHA-256 hash for every file in directoryPath.
 */
export async function computeDirectoryHashes(
  directoryPath: string,
): Promise<ManagedSkillFiles> {
  const relativeFilePaths = await listRelativeFilePaths(directoryPath);
  const hashEntries = await Promise.all(
    relativeFilePaths.map(async (relativeFilePath) => {
      const fileBuffer = await fs.readFile(
        path.join(directoryPath, relativeFilePath),
      );

      return [
        toPortableRelativePath(relativeFilePath),
        createHash('sha256').update(fileBuffer).digest('hex'),
      ] as const;
    }),
  );

  return Object.fromEntries(hashEntries);
}

/**
 * Detects whether a managed skill directory has local content changes relative to the lockfile snapshot.
 */
export async function detectLocalSkillEdits(input: {
  skillDir: string;
  storedFiles: ManagedSkillFiles | undefined;
}): Promise<{ changedFiles: string[]; modified: boolean }> {
  if (!input.storedFiles) {
    return {
      changedFiles: [],
      modified: false,
    };
  }

  if (!(await fs.pathExists(input.skillDir))) {
    return {
      changedFiles: [],
      modified: false,
    };
  }

  const currentFiles = await computeDirectoryHashes(input.skillDir);
  const changedFiles = [
    ...new Set([
      ...Object.keys(input.storedFiles),
      ...Object.keys(currentFiles),
    ]),
  ]
    .filter(
      (relativeFilePath) =>
        input.storedFiles?.[relativeFilePath] !==
        currentFiles[relativeFilePath],
    )
    .sort((left, right) => left.localeCompare(right));

  return {
    changedFiles,
    modified: changedFiles.length > 0,
  };
}

/**
 * Clones a remote repository into a temporary checkout and resolves the fetched commit.
 */
export async function cloneRemoteRepo(input: {
  ref: string | undefined;
  repo: string;
}): Promise<RemoteRepoCheckout> {
  const normalizedRepo = normalizeRemoteRepo(input.repo);
  const checkoutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agents-skill.'));

  try {
    const git = simpleGit(checkoutDir);

    await git.init();
    await git.addRemote('origin', normalizedRepo);

    if (input.ref) {
      await git.fetch('origin', input.ref, ['--depth', '1']);
    } else {
      await git.fetch('origin', 'HEAD', ['--depth', '1']);
    }

    await git.checkout(['--quiet', 'FETCH_HEAD']);

    return {
      checkoutDir,
      cleanup: async () => {
        await fs.remove(checkoutDir);
      },
      commit: await git.revparse(['HEAD']),
    };
  } catch (error: unknown) {
    await fs.remove(checkoutDir);
    throw toError({
      prefix: `Failed to fetch repository from ${normalizedRepo}`,
      error,
    });
  }
}

/**
 * Removes one temporary repository checkout returned by `cloneRemoteRepo`.
 */
export async function cleanupRemoteRepoCheckout(
  checkout: RemoteRepoCheckout,
): Promise<void> {
  await checkout.cleanup();
}

/**
 * Returns the source directory path for a skill at its default location (`skills/<skillName>`), confirming the directory and SKILL.md exist.
 */
export async function resolveSkillSourceDir(input: {
  checkoutDir: string;
  repo: string;
  skillName: string;
}): Promise<string> {
  const skillPath = resolveManagedSkillImportPath({
    skillName: input.skillName,
  });
  const sourceDir = resolveRemoteSkillDirectory({
    checkoutDir: input.checkoutDir,
    skillPath,
  });

  await validateRemoteSkillDirectory({
    sourceDir,
    skillPath,
    repo: normalizeRemoteRepo(input.repo),
  });

  return sourceDir;
}

/**
 * Returns the source directory path for a skill at an explicit repository-relative path, confirming the directory and SKILL.md exist.
 */
export async function resolveSkillSourceDirByPath(input: {
  checkoutDir: string;
  repo: string;
  skillPath: string;
}): Promise<string> {
  const normalizedSkillPath = normalizeImportedSkillPath(input.skillPath);

  if (normalizedSkillPath === undefined) {
    throw new Error('Skill path may not be empty');
  }

  const sourceDir = resolveRemoteSkillDirectory({
    checkoutDir: input.checkoutDir,
    skillPath: normalizedSkillPath,
  });

  await validateRemoteSkillDirectory({
    sourceDir,
    skillPath: normalizedSkillPath,
    repo: normalizeRemoteRepo(input.repo),
  });

  return sourceDir;
}

/**
 * Fetches a validated remote skill directory snapshot for a specific repository path.
 */
export async function fetchRemoteSkillSnapshot(input: {
  ref: string | undefined;
  repo: string;
  skillPath: string;
}): Promise<RemoteSkillSnapshot> {
  const normalizedRepo = normalizeRemoteRepo(input.repo);
  const checkout = await cloneRemoteRepo({
    ref: input.ref,
    repo: normalizedRepo,
  });

  try {
    const sourceDir = resolveRemoteSkillDirectory({
      checkoutDir: checkout.checkoutDir,
      skillPath: input.skillPath,
    });

    await validateRemoteSkillDirectory({
      sourceDir,
      skillPath: input.skillPath,
      repo: normalizedRepo,
    });

    return {
      cleanup: checkout.cleanup,
      commit: checkout.commit,
      sourceDir,
    };
  } catch (error: unknown) {
    await checkout.cleanup();
    throw toError({
      prefix: `Failed to fetch skill from ${normalizedRepo}`,
      error,
    });
  }
}

/**
 * Removes one temporary remote skill snapshot returned by `fetchRemoteSkillSnapshot`.
 */
export async function cleanupRemoteSkillSnapshot(
  snapshot: RemoteSkillSnapshot,
): Promise<void> {
  await snapshot.cleanup();
}

export async function replaceManagedSkillDirectory({
  targetDir,
  sourceDir,
}: {
  targetDir: string;
  sourceDir: string;
}): Promise<void> {
  await fs.ensureDir(path.dirname(targetDir));
  const stagingRoot = await fs.mkdtemp(
    path.join(path.dirname(targetDir), `${path.basename(targetDir)}.`),
  );
  const stagedDir = path.join(stagingRoot, path.basename(targetDir));

  try {
    await fs.copy(sourceDir, stagedDir);
    await fs.remove(targetDir);
    await fs.move(stagedDir, targetDir, { overwrite: true });
  } finally {
    await fs.remove(stagingRoot);
  }
}

export async function removeManagedSkillDirectory(
  context: AgentsContext,
  { skillName }: { skillName: string },
): Promise<void> {
  await fs.remove(getManagedSkillDirectory(context, { skillName }));
}

export function formatManagedSkillSummary(skill: ManagedSkill): string {
  const refLabel = skill.ref ?? 'HEAD';
  return `${skill.name} repo=${skill.repo} path=${skill.path} ref=${refLabel} commit=${shortCommit(skill.commit)}`;
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function timestampNow(): string {
  return new Date().toISOString();
}

/**
 * Recursively lists all file paths inside a directory relative to that directory root.
 */
async function listRelativeFilePaths(directoryPath: string): Promise<string[]> {
  const directoryEntries = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });
  const relativeFilePaths: string[] = [];

  for (const directoryEntry of directoryEntries) {
    const entryPath = path.join(directoryPath, directoryEntry.name);

    if (directoryEntry.isDirectory()) {
      const nestedFilePaths = await listRelativeFilePaths(entryPath);

      for (const nestedFilePath of nestedFilePaths) {
        relativeFilePaths.push(path.join(directoryEntry.name, nestedFilePath));
      }

      continue;
    }

    if (directoryEntry.isFile()) {
      relativeFilePaths.push(directoryEntry.name);
    }
  }

  return relativeFilePaths.sort((left, right) => left.localeCompare(right));
}

/**
 * Normalizes a relative path to use forward slashes for lockfile portability.
 */
function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function sortSkillsLockfile(lockfile: SkillsLockfile): SkillsLockfile {
  return {
    version: lockfile.version,
    skills: [...lockfile.skills].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
  };
}

/**
 * Derives the default managed skill name when the caller does not provide `--as`.
 *
 * When `skillPath` points to a subdirectory, the last path segment is used.
 * When `skillPath` is `.`, the repository name is used instead.
 *
 * @example
 * Input: { repo: 'anthropics/skills', skillPath: 'skills/skill-creator' }
 * Output: 'skill-creator'
 *
 * @example
 * Input: { repo: 'https://github.com/anthropics/skills.git', skillPath: '.' }
 * Output: 'skills'
 */
function inferDefaultSkillName({
  repo,
  skillPath,
}: {
  repo: string;
  skillPath: string;
}): string {
  if (skillPath !== '.') {
    return path.basename(skillPath);
  }

  const trimmedRepo = repo.replace(/\/+$/u, '');
  const repoSegments = trimmedRepo.split(/[/:]/u).filter((segment) => segment);
  const lastSegment = repoSegments[repoSegments.length - 1] ?? trimmedRepo;

  return lastSegment.endsWith('.git') ? lastSegment.slice(0, -4) : lastSegment;
}

const githubRepoShorthandPattern =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u;

function resolveRemoteSkillDirectory({
  checkoutDir,
  skillPath,
}: {
  checkoutDir: string;
  skillPath: string;
}): string {
  const candidateDir = path.resolve(checkoutDir, skillPath);
  const relativeCandidatePath = path.relative(checkoutDir, candidateDir);

  if (
    relativeCandidatePath === '..' ||
    relativeCandidatePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCandidatePath)
  ) {
    throw new Error(`Skill path escapes the repository checkout: ${skillPath}`);
  }

  return candidateDir;
}

async function validateRemoteSkillDirectory({
  sourceDir,
  skillPath,
  repo,
}: {
  sourceDir: string;
  skillPath: string;
  repo: string;
}): Promise<void> {
  if (!(await fs.pathExists(sourceDir))) {
    throw new Error(`Skill path does not exist in ${repo}: ${skillPath}`);
  }

  const stats = await fs.stat(sourceDir);

  if (!stats.isDirectory()) {
    throw new Error(`Skill path is not a directory in ${repo}: ${skillPath}`);
  }

  const skillMarkdownPath = path.join(sourceDir, 'SKILL.md');

  if (!(await fs.pathExists(skillMarkdownPath))) {
    throw new Error(
      `Missing SKILL.md in imported skill directory: ${skillPath}`,
    );
  }
}

function toError({ prefix, error }: { prefix: string; error: unknown }): Error {
  if (error instanceof Error) {
    return new Error(`${prefix}: ${error.message}`);
  }

  return new Error(`${prefix}: ${String(error)}`);
}
