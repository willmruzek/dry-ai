import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { PlatformError } from '@effect/platform/Error';
import { SystemError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Data, Effect, Schema } from 'effect';
import * as ParseResult from 'effect/ParseResult';
import { simpleGit } from 'simple-git';

import type { CommandEnv } from './command-env.js';
import type { AgentsContext } from './context.js';
import { PathExistsCheckError } from './fs.js';
import {
  EnsureSkillsSourceRootError,
  GitCheckoutTempDirectoryError,
  ListSkillSubdirectoriesError,
  RemoteSkillValidationFsError,
  RemoveManagedSkillDirectoryError,
  ReplaceManagedSkillOutputError,
  SkillContentHashReadError,
  SkillDirectoryWalkError,
  SkillsLockfileExistsCheckError,
  SkillsLockfileEncodeError,
  SkillsLockfileReadContentsError,
  SkillsLockfileWriteError,
} from './sync.js';

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

const SkillsLockfileJson = Schema.parseJson(SkillsLockfile, { space: 2 });

/**
 * Explains that a name is missing from the skills lockfile and suggests next steps.
 */
export function managedSkillNotFoundMessage(skillName: string): string {
  return (
    `Managed skill not found: ${skillName}. ` +
    'Run `skills list` to see managed skill names, or `skills add <repo> --skill <name>` to import one.'
  );
}

export class InvalidSkillsLockfile extends Data.TaggedError(
  'InvalidSkillsLockfile',
)<{
  readonly lockfilePath: string;
  readonly cause: ParseResult.ParseError;
}> {
  override get message(): string {
    return `Invalid skills lockfile at ${this.lockfilePath}:\n${ParseResult.TreeFormatter.formatErrorSync(this.cause)}`;
  }
}

export class ManagedSkillNotFoundError extends Data.TaggedError(
  'ManagedSkillNotFoundError',
)<{
  readonly skillName: string;
}> {
  override get message(): string {
    return managedSkillNotFoundMessage(this.skillName);
  }
}

/** Why {@link validateRemoteSkillDirectoryEffect} rejected the skill directory. */
export type RemoteSkillDirectoryInvalidReason =
  | 'path_missing'
  | 'not_directory'
  | 'missing_skill_md';

export class RemoteSkillDirectoryInvalid extends Data.TaggedError(
  'RemoteSkillDirectoryInvalid',
)<{
  readonly repo: string;
  readonly skillPath: string;
  readonly reason: RemoteSkillDirectoryInvalidReason;
}> {
  override get message(): string {
    switch (this.reason) {
      case 'path_missing':
        return `Skill path does not exist in ${this.repo}: ${this.skillPath}`;
      case 'not_directory':
        return `Skill path is not a directory in ${this.repo}: ${this.skillPath}`;
      case 'missing_skill_md':
        return `Missing SKILL.md in imported skill directory: ${this.skillPath}`;
      default: {
        const _exhaustive: never = this.reason;
        return _exhaustive;
      }
    }
  }
}

/** Explicit `--path` / import path normalized to nothing usable. */
export class RemoteSkillImportPathInvalidError extends Data.TaggedError(
  'RemoteSkillImportPathInvalidError',
)<{
  readonly reason: 'empty_path';
}> {
  override get message(): string {
    return 'Skill path may not be empty';
  }
}

/** Resolved skill directory leaves the cloned checkout (path traversal). */
export class RemoteSkillCheckoutEscapeError extends Data.TaggedError(
  'RemoteSkillCheckoutEscapeError',
)<{
  readonly skillPath: string;
}> {
  override get message(): string {
    return `Skill path escapes the repository checkout: ${this.skillPath}`;
  }
}

/** Failure resolving the on-disk directory under the checkout (sync exception from path join). */
export class RemoteSkillDirectoryResolveError extends Data.TaggedError(
  'RemoteSkillDirectoryResolveError',
)<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Could not resolve remote skill directory: ${String(this.cause)}`;
  }
}

/** Checkout + validation failed while fetching a remote skill snapshot; outer cleanup runs before this fails. */
export class FetchRemoteSkillError extends Data.TaggedError(
  'FetchRemoteSkillError',
)<{
  readonly repo: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const inner =
      this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Failed to fetch skill from ${this.repo}: ${inner}`;
  }
}

/** `simple-git` clone/fetch/checkout failed under the temporary repo checkout. */
export class GitRemoteOperationError extends Data.TaggedError(
  'GitRemoteOperationError',
)<{
  readonly repo: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    const inner =
      this.cause instanceof Error ? this.cause.message : String(this.cause);
    return `Failed to fetch repository from ${this.repo}: ${inner}`;
  }
}

/** Errors produced by {@link loadSkillsLockfile} (I/O or invalid JSON/schema). */
export type LoadSkillsLockfileError =
  | InvalidSkillsLockfile
  | SkillsLockfileExistsCheckError
  | SkillsLockfileReadContentsError;

export type ManagedSkill = Schema.Schema.Type<typeof SkillLockEntry>;
export type SkillsLockfile = Schema.Schema.Type<typeof SkillsLockfile>;
export type ManagedSkillFiles = Schema.Schema.Type<typeof ManagedSkillFiles>;

export type RemoteSkillSnapshot = {
  cleanup: () => Effect.Effect<void, PlatformError, FileSystem>;
  commit: string;
  sourceDir: string;
};

export type RemoteRepoCheckout = {
  checkoutDir: string;
  cleanup: () => Effect.Effect<void, PlatformError, FileSystem>;
  commit: string;
};

export function createEmptySkillsLockfile(): SkillsLockfile {
  return {
    version: 1,
    skills: [],
  };
}

/**
 * Ensure the skills source root directory exists (via Effect {@link FileSystem}).
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function ensureSkillsRoot(
  env: SkillsLockfileEnv,
): Effect.Effect<void, EnsureSkillsSourceRootError, FileSystem> {
  const { context } = env;

  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(context.sourceRoots.skills, {
      recursive: true,
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new EnsureSkillsSourceRootError({
          skillsRoot: context.sourceRoots.skills,
          cause,
        }),
    ),
  );
}

/**
 * Ensure a skills lockfile exists at the path defined in `context`, creating and saving an empty lockfile when it is missing.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 *
 * @param context - Execution context containing `skillsLockfilePath` and filesystem access used to read/write the lockfile
 */
export function ensureSkillsLockfile(
  env: SkillsLockfileEnv,
): Effect.Effect<
  void,
  | SkillsLockfileEncodeError
  | SkillsLockfileExistsCheckError
  | SkillsLockfileWriteError,
  FileSystem
> {
  const { context } = env;

  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (
      yield* fs.exists(context.skillsLockfilePath).pipe(
        Effect.mapError(
          (cause) =>
            new SkillsLockfileExistsCheckError({
              lockfilePath: context.skillsLockfilePath,
              cause,
            }),
        ),
      )
    ) {
      return;
    }

    yield* saveSkillsLockfile(env, {
      lockfile: createEmptySkillsLockfile(),
    });
  });
}

/**
 * Returns whether `filePath` exists according to the Effect {@link FileSystem}
 * service (same layer as lockfile and managed-skill directory I/O).
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function pathExistsInFileSystem(
  filePath: string,
): Effect.Effect<boolean, PathExistsCheckError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* fs.exists(filePath);
  }).pipe(
    Effect.mapError((cause) => new PathExistsCheckError({ filePath, cause })),
  );
}

/**
 * Load the repository's skills lockfile, validate it against the schema, and return a sorted lockfile object.
 *
 * Requires an Effect {@link FileSystem} service (provide `env.runtime.fileSystemLayer` at the command root).
 *
 * @param env - Environment containing `context` with `skillsLockfilePath`.
 * @returns Effect that succeeds with the decoded and lexicographically sorted `SkillsLockfile`, or fails with {@link InvalidSkillsLockfile} when a lockfile exists but fails schema parsing/validation, or with a tagged filesystem error when probing or reading fails.
 */
export function loadSkillsLockfile(
  env: SkillsLockfileEnv,
): Effect.Effect<SkillsLockfile, LoadSkillsLockfileError, FileSystem> {
  const { context } = env;

  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const lockfilePath = context.skillsLockfilePath;

    if (
      !(yield* fs
        .exists(lockfilePath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new SkillsLockfileExistsCheckError({ lockfilePath, cause }),
          ),
        ))
    ) {
      return createEmptySkillsLockfile();
    }

    const rawLockfile = yield* fs
      .readFileString(lockfilePath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new SkillsLockfileReadContentsError({ lockfilePath, cause }),
        ),
      );

    const decoded = yield* Schema.decodeUnknown(
      Schema.parseJson(SkillsLockfile),
    )(rawLockfile).pipe(
      Effect.mapError(
        (parseError) =>
          new InvalidSkillsLockfile({
            lockfilePath,
            cause: parseError,
          }),
      ),
    );

    return sortSkillsLockfile(decoded);
  });
}

/**
 * Write the skills lockfile to disk as sorted JSON (via Effect {@link FileSystem}).
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function saveSkillsLockfile(
  env: SkillsLockfileEnv,
  { lockfile }: { lockfile: SkillsLockfile },
): Effect.Effect<
  void,
  SkillsLockfileEncodeError | SkillsLockfileWriteError,
  FileSystem
> {
  const { context } = env;
  const normalizedLockfile = sortSkillsLockfile(lockfile);

  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const json = yield* Schema.encode(SkillsLockfileJson)(
      normalizedLockfile,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SkillsLockfileEncodeError({
            lockfilePath: context.skillsLockfilePath,
            cause,
          }),
      ),
    );
    yield* fs
      .writeFile(
        context.skillsLockfilePath,
        new TextEncoder().encode(`${json}\n`),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SkillsLockfileWriteError({
              lockfilePath: context.skillsLockfilePath,
              cause,
            }),
        ),
      );
  });
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

/**
 * List names of subdirectories under the skills source root (via Effect {@link FileSystem}).
 * Ensures the root exists, ignores non-directories, returns a sorted name list.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function listLocalSkillDirectories(
  env: SkillsLockfileEnv,
): Effect.Effect<string[], ListSkillSubdirectoriesError, FileSystem> {
  const { context } = env;
  const skillsRoot = context.sourceRoots.skills;

  return Effect.gen(function* () {
    const fs = yield* FileSystem;

    yield* fs.makeDirectory(skillsRoot, { recursive: true });

    const names = yield* fs.readDirectory(skillsRoot);

    const directories = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const fullPath = path.join(skillsRoot, name);
        const info = yield* fs.stat(fullPath);
        return info.type === 'Directory' ? name : null;
      }),
    );

    return [
      ...directories.filter((name): name is string => name !== null),
    ].sort((a, b) => a.localeCompare(b));
  }).pipe(
    Effect.mapError(
      (cause) => new ListSkillSubdirectoriesError({ skillsRoot, cause }),
    ),
  );
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
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function computeDirectoryHashes(
  directoryPath: string,
): Effect.Effect<
  ManagedSkillFiles,
  SkillDirectoryWalkError | SkillContentHashReadError,
  FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const relativeFilePaths = yield* listRelativeFilePaths(directoryPath);
    const hashEntries: [string, string][] = [];

    for (const relativeFilePath of relativeFilePaths) {
      const fullPath = path.join(directoryPath, relativeFilePath);
      const fileBytes = yield* fs.readFile(fullPath).pipe(
        Effect.mapError(
          (cause) =>
            new SkillContentHashReadError({
              directoryPath,
              relativePath: relativeFilePath,
              cause,
            }),
        ),
      );
      const digest = createHash('sha256').update(fileBytes).digest('hex');

      hashEntries.push([toPortableRelativePath(relativeFilePath), digest]);
    }

    return Object.fromEntries(hashEntries);
  });
}

/**
 * Detects whether a managed skill directory has local content changes relative to the lockfile snapshot.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function detectLocalSkillEdits(input: {
  skillDir: string;
  storedFiles: ManagedSkillFiles | undefined;
}): Effect.Effect<
  { changedFiles: string[]; modified: boolean },
  PathExistsCheckError | SkillDirectoryWalkError | SkillContentHashReadError,
  FileSystem
> {
  return Effect.gen(function* () {
    if (!input.storedFiles) {
      return {
        changedFiles: [],
        modified: false,
      };
    }

    const skillDirExists = yield* pathExistsInFileSystem(input.skillDir);

    if (!skillDirExists) {
      return {
        changedFiles: [],
        modified: false,
      };
    }

    const currentFiles = yield* computeDirectoryHashes(input.skillDir);
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
      .slice()
      .sort((left, right) => left.localeCompare(right));

    return {
      changedFiles,
      modified: changedFiles.length > 0,
    };
  });
}

/**
 * Clones a remote repository into a temporary checkout and resolves the fetched commit.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function cloneRemoteRepo(input: {
  ref: string | undefined;
  repo: string;
}): Effect.Effect<
  RemoteRepoCheckout,
  GitRemoteOperationError | GitCheckoutTempDirectoryError,
  FileSystem
> {
  return Effect.gen(function* () {
    const normalizedRepo = normalizeRemoteRepo(input.repo);

    const fs = yield* FileSystem;
    const tempPrefix = path.join(os.tmpdir(), 'agents-skill.');
    const checkoutDir = yield* fs
      .makeTempDirectory({
        prefix: tempPrefix,
      })
      .pipe(
        Effect.mapError(
          (cause) => new GitCheckoutTempDirectoryError({ tempPrefix, cause }),
        ),
      );

    const git = simpleGit(checkoutDir);

    const commit = yield* Effect.tryPromise({
      try: async () => {
        await git.init();
        await git.addRemote('origin', normalizedRepo);
        if (input.ref) {
          await git.fetch('origin', input.ref, ['--depth', '1']);
        } else {
          await git.fetch('origin', 'HEAD', ['--depth', '1']);
        }
        await git.checkout(['--quiet', 'FETCH_HEAD']);
        return await git.revparse(['HEAD']);
      },
      catch: (cause) =>
        new GitRemoteOperationError({
          repo: normalizedRepo,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* fs
            .remove(checkoutDir, { recursive: true, force: true })
            .pipe(Effect.ignoreLogged);
          return yield* error;
        }),
      ),
    );

    return {
      checkoutDir,
      cleanup: () =>
        fs.remove(checkoutDir, { recursive: true, force: true }).pipe(
          Effect.catchIf(
            (error): error is SystemError =>
              error instanceof SystemError && error.reason === 'NotFound',
            () => Effect.void,
          ),
        ),
      commit,
    };
  });
}

/**
 * Removes one temporary repository checkout returned by `cloneRemoteRepo`.
 */
export function cleanupRemoteRepoCheckout(
  checkout: RemoteRepoCheckout,
): Effect.Effect<void, PlatformError, FileSystem> {
  return checkout.cleanup();
}

/**
 * Returns the source directory path for a skill at its default location (`skills/<skillName>`), confirming the directory and SKILL.md exist.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function resolveSkillSourceDir(input: {
  checkoutDir: string;
  repo: string;
  skillName: string;
}): Effect.Effect<
  string,
  | RemoteSkillDirectoryResolveError
  | RemoteSkillCheckoutEscapeError
  | RemoteSkillDirectoryInvalid
  | RemoteSkillValidationFsError,
  FileSystem
> {
  const skillPath = resolveManagedSkillImportPath({
    skillName: input.skillName,
  });

  return Effect.gen(function* () {
    const sourceDir = yield* Effect.try({
      try: () =>
        resolveRemoteSkillDirectory({
          checkoutDir: input.checkoutDir,
          skillPath,
        }),
      catch: mapResolveRemoteSkillTryCause,
    });

    yield* validateRemoteSkillDirectoryEffect({
      repo: normalizeRemoteRepo(input.repo),
      skillPath,
      sourceDir,
    });

    return sourceDir;
  });
}

/**
 * Returns the source directory path for a skill at an explicit repository-relative path, confirming the directory and SKILL.md exist.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function resolveSkillSourceDirByPath(input: {
  checkoutDir: string;
  repo: string;
  skillPath: string;
}): Effect.Effect<
  string,
  | RemoteSkillImportPathInvalidError
  | RemoteSkillDirectoryResolveError
  | RemoteSkillCheckoutEscapeError
  | RemoteSkillDirectoryInvalid
  | RemoteSkillValidationFsError,
  FileSystem
> {
  return Effect.gen(function* () {
    const normalizedSkillPath = normalizeImportedSkillPath(input.skillPath);

    if (normalizedSkillPath === undefined) {
      return yield* new RemoteSkillImportPathInvalidError({
        reason: 'empty_path',
      });
    }

    const sourceDir = yield* Effect.try({
      try: () =>
        resolveRemoteSkillDirectory({
          checkoutDir: input.checkoutDir,
          skillPath: normalizedSkillPath,
        }),
      catch: mapResolveRemoteSkillTryCause,
    });

    yield* validateRemoteSkillDirectoryEffect({
      repo: normalizeRemoteRepo(input.repo),
      skillPath: normalizedSkillPath,
      sourceDir,
    });

    return sourceDir;
  });
}

/**
 * Fetches a validated remote skill directory snapshot for a specific repository path.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function fetchRemoteSkillSnapshot(input: {
  ref: string | undefined;
  repo: string;
  skillPath: string;
}): Effect.Effect<
  RemoteSkillSnapshot,
  | GitCheckoutTempDirectoryError
  | GitRemoteOperationError
  | FetchRemoteSkillError
  | RemoteSkillDirectoryResolveError
  | RemoteSkillCheckoutEscapeError
  | RemoteSkillDirectoryInvalid
  | RemoteSkillValidationFsError,
  FileSystem
> {
  const normalizedRepo = normalizeRemoteRepo(input.repo);

  return Effect.gen(function* () {
    const checkout = yield* cloneRemoteRepo({
      ref: input.ref,
      repo: normalizedRepo,
    });

    const sourceDir = yield* Effect.gen(function* () {
      const sd = yield* Effect.try({
        try: () =>
          resolveRemoteSkillDirectory({
            checkoutDir: checkout.checkoutDir,
            skillPath: input.skillPath,
          }),
        catch: mapResolveRemoteSkillTryCause,
      });

      yield* validateRemoteSkillDirectoryEffect({
        repo: normalizedRepo,
        skillPath: input.skillPath,
        sourceDir: sd,
      });

      return sd;
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* checkout.cleanup().pipe(Effect.catchAll(() => Effect.void));
          return yield* new FetchRemoteSkillError({
            repo: normalizedRepo,
            cause: error,
          });
        }),
      ),
    );

    return {
      cleanup: checkout.cleanup,
      commit: checkout.commit,
      sourceDir,
    };
  });
}

/**
 * Removes one temporary remote skill snapshot returned by `fetchRemoteSkillSnapshot`.
 */
export function cleanupRemoteSkillSnapshot(
  snapshot: RemoteSkillSnapshot,
): Effect.Effect<void, PlatformError, FileSystem> {
  return snapshot.cleanup();
}

export function replaceManagedSkillDirectory({
  sourceDir,
  targetDir,
}: {
  sourceDir: string;
  targetDir: string;
}): Effect.Effect<void, ReplaceManagedSkillOutputError, FileSystem> {
  const targetParent = path.dirname(targetDir);
  const targetBase = path.basename(targetDir);

  return Effect.gen(function* () {
    const fs = yield* FileSystem;

    yield* fs.makeDirectory(targetParent, { recursive: true });

    const stagingRoot = yield* fs.makeTempDirectory({
      directory: targetParent,
      prefix: `${targetBase}.`,
    });
    const stagedDir = path.join(stagingRoot, targetBase);

    yield* Effect.gen(function* () {
      yield* fs.copy(sourceDir, stagedDir);
      yield* fs.remove(targetDir, { recursive: true, force: true });
      yield* fs.rename(stagedDir, targetDir);
    }).pipe(
      Effect.ensuring(
        fs
          .remove(stagingRoot, { recursive: true, force: true })
          .pipe(Effect.catchAll(() => Effect.void)),
      ),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ReplaceManagedSkillOutputError({ targetDir, sourceDir, cause }),
    ),
  );
}

/**
 * Remove the on-disk directory for a managed skill via Effect {@link FileSystem}.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function removeManagedSkillDirectory(
  env: SkillsLockfileEnv,
  { skillName }: { skillName: string },
): Effect.Effect<void, RemoveManagedSkillDirectoryError, FileSystem> {
  const { context } = env;
  const directoryPath = getManagedSkillDirectory(context, { skillName });

  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.remove(directoryPath, { recursive: true, force: true });
  }).pipe(
    Effect.mapError(
      (cause) => new RemoveManagedSkillDirectoryError({ directoryPath, cause }),
    ),
  );
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
function listRelativeFilePaths(
  directoryPath: string,
): Effect.Effect<string[], SkillDirectoryWalkError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    const names = yield* fs.readDirectory(directoryPath);
    const relativeFilePaths: string[] = [];

    for (const name of names) {
      const entryPath = path.join(directoryPath, name);
      const info = yield* fs.stat(entryPath);

      if (info.type === 'Directory') {
        const nestedFilePaths = yield* listRelativeFilePaths(entryPath);

        for (const nestedFilePath of nestedFilePaths) {
          relativeFilePaths.push(path.join(name, nestedFilePath));
        }

        continue;
      }

      if (info.type === 'File') {
        relativeFilePaths.push(name);
      }
    }

    return [...relativeFilePaths].sort((left, right) =>
      left.localeCompare(right),
    );
  }).pipe(
    Effect.mapError((cause): SkillDirectoryWalkError => {
      if (cause._tag === 'SkillDirectoryWalkError') {
        return cause;
      }
      return new SkillDirectoryWalkError({ directoryPath, cause });
    }),
  );
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

function mapResolveRemoteSkillTryCause(cause: unknown) {
  return cause instanceof RemoteSkillCheckoutEscapeError
    ? cause
    : new RemoteSkillDirectoryResolveError({ cause });
}

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
    throw new RemoteSkillCheckoutEscapeError({ skillPath });
  }

  return candidateDir;
}

function validateRemoteSkillDirectoryEffect(input: {
  repo: string;
  skillPath: string;
  sourceDir: string;
}): Effect.Effect<
  void,
  RemoteSkillDirectoryInvalid | RemoteSkillValidationFsError,
  FileSystem
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;

    if (!(yield* fs.exists(input.sourceDir))) {
      return yield* new RemoteSkillDirectoryInvalid({
        repo: input.repo,
        skillPath: input.skillPath,
        reason: 'path_missing',
      });
    }

    const info = yield* fs.stat(input.sourceDir);

    if (info.type !== 'Directory') {
      return yield* new RemoteSkillDirectoryInvalid({
        repo: input.repo,
        skillPath: input.skillPath,
        reason: 'not_directory',
      });
    }

    const skillMarkdownPath = path.join(input.sourceDir, 'SKILL.md');

    if (!(yield* fs.exists(skillMarkdownPath))) {
      return yield* new RemoteSkillDirectoryInvalid({
        repo: input.repo,
        skillPath: input.skillPath,
        reason: 'missing_skill_md',
      });
    }
  }).pipe(
    Effect.mapError(
      (
        error: RemoteSkillDirectoryInvalid | PlatformError,
      ): RemoteSkillDirectoryInvalid | RemoteSkillValidationFsError => {
        if (error._tag === 'RemoteSkillDirectoryInvalid') {
          return error;
        }
        return new RemoteSkillValidationFsError({
          sourceDir: input.sourceDir,
          cause: error,
        });
      },
    ),
  );
}
