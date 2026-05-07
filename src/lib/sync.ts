import { createHash } from 'node:crypto';
import path from 'node:path';

import type { PlatformError } from '@effect/platform/Error';
import { SystemError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Chalk } from 'chalk';
import { Effect } from 'effect';
import { glob } from 'glob';
import { z } from 'zod';

import {
  buildCommandArtifactSpecsByAgent,
  buildRuleArtifactSpecsByAgent,
  createOwnershipKey,
  describeOwnershipKey,
  getAgentLabel,
  isSyncAgent,
  listTargetRootPaths,
  SYNC_AGENTS,
  SYNC_ITEM_KINDS,
  type ArtifactSpec,
  type OwnershipKey,
  type SyncAgent,
  type SyncItemKind,
  type TargetRoots,
  AGENT_DEFINITIONS,
} from './agents.js';
import type { CommandEnv } from './command-env.js';
import {
  commandFrontmatterSchema,
  parseMdWithFrontmatter,
  renderMarkdown,
  ruleFrontmatterSchema,
  validateFrontmatter,
} from './frontmatter.js';
import { computeDirectoryHashes, pathExistsInFileSystem } from './skills.js';

/** Written to `sync-manifest.json`; bump when the manifest shape changes. */
export const SYNC_MANIFEST_VERSION = 2 as const;

type SyncAppliedChangeType = 'installed' | 'updated' | 'unchanged';
type SyncChangeType = SyncAppliedChangeType | 'removed';

const chalk = new Chalk({ level: 3 });

function ensureDirectory(
  directoryPath: string,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(directoryPath, { recursive: true });
  });
}

function readFileUtf8(
  filePath: string,
): Effect.Effect<string, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* fs.readFileString(filePath);
  });
}

function writeTextFile(
  filePath: string,
  content: string,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFile(filePath, new TextEncoder().encode(content));
  });
}

function removePath(
  targetPath: string,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.remove(targetPath, { recursive: true, force: true });
  });
}

/**
 * Clears a directory’s contents and ensures the directory exists (like `fs-extra.emptyDir`).
 */
function emptyDirectory(
  directoryPath: string,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.remove(directoryPath, { recursive: true, force: true }).pipe(
      Effect.catchIf(
        (error): error is SystemError =>
          error instanceof SystemError && error.reason === 'NotFound',
        () => Effect.void,
      ),
    );
    yield* fs.makeDirectory(directoryPath, { recursive: true });
  });
}

const syncAgentSchema = z.custom<SyncAgent>(
  (value) => typeof value === 'string' && isSyncAgent(value),
  {
    message: 'Expected one configured sync agent.',
  },
);

const syncManifestEntrySchema = z.object({
  agent: syncAgentSchema,
  kind: z.enum(SYNC_ITEM_KINDS),
  name: z.string().min(1),
  outputPath: z.string().min(1),
});

const syncManifestSchema = z.object({
  version: z.literal(SYNC_MANIFEST_VERSION),
  outputs: z.array(syncManifestEntrySchema),
});

type DesiredSyncSpec = {
  kind: SyncItemKind;
  name: string;
  sourcePath: string;
  artifactSpecs: readonly ArtifactSpec[];
};

type ItemSyncChange = {
  artifactSpec: ArtifactSpec;
  agent: SyncAgent;
  changeType: SyncAppliedChangeType;
};

type AppliedSyncResult = {
  desiredSpec: DesiredSyncSpec;
  changes: ItemSyncChange[];
};

type ReportedAgentSyncChange = {
  kind: SyncItemKind;
  name: string;
  changeType: SyncChangeType;
};

type SkippedSyncResult = {
  desiredSpec: DesiredSyncSpec;
  conflictDescriptions: string[];
};

type SyncabilityResult = {
  syncableSpecs: DesiredSyncSpec[];
  skippedSpecs: SkippedSyncResult[];
  skippedOwnershipKeys: ReadonlySet<OwnershipKey>;
  desiredOutputPaths: ReadonlySet<string>;
};

type DesiredSpecCandidate = {
  desiredSpec: DesiredSyncSpec;
  artifactCandidates: DesiredArtifactCandidate[];
};

type DesiredArtifactCandidate = {
  artifactSpec: ArtifactSpec;
  ownershipKey: OwnershipKey;
  artifactPath: string;
  conflictDescriptions: string[];
};

type PartitionedManifestEntries = {
  removedEntries: SyncManifestEntry[];
  preservedEntries: SyncManifestEntry[];
};

type SyncChanges = {
  syncableSpecs: DesiredSyncSpec[];
  skippedSpecs: SkippedSyncResult[];
  desiredOutputPaths: ReadonlySet<string>;
  removedEntries: SyncManifestEntry[];
  preservedEntries: SyncManifestEntry[];
};

type SyncApplyResult = {
  appliedSpecs: AppliedSyncResult[];
  removedEntries: SyncManifestEntry[];
};

type SyncManifestEntry = z.output<typeof syncManifestEntrySchema>;
type SyncManifest = z.output<typeof syncManifestSchema>;

/**
 * Validates and returns the agent name from an artifact spec, throwing if it is unrecognized.
 */
function parseSyncAgent(agent: string): SyncAgent {
  if (isSyncAgent(agent)) {
    return agent;
  }

  throw new Error(`Unsupported sync agent: ${agent}`);
}

/**
 * Derives the ownership key claimed by one artifact spec for conflict detection.
 */
function deriveOwnershipKeyForArtifactSpec(
  desiredSpec: DesiredSyncSpec,
  artifactSpec: ArtifactSpec,
): OwnershipKey {
  return createOwnershipKey(
    parseSyncAgent(artifactSpec.agent),
    desiredSpec.kind,
    {
      name: desiredSpec.name,
      outputPath: artifactSpec.managedArtifactPath,
    },
  );
}

/**
 * Returns the ownership key for a saved manifest entry.
 */
function deriveOwnershipKeyForManifestEntry(
  manifestEntry: SyncManifestEntry,
): OwnershipKey {
  return createOwnershipKey(manifestEntry.agent, manifestEntry.kind, {
    name: manifestEntry.name,
    outputPath: manifestEntry.outputPath,
  });
}

/**
 * Returns the first manifest agent id that is syntactically readable but no
 * longer registered. Other malformed manifest shapes keep the generic recovery
 * path below.
 */
function findUnregisteredManifestAgent(
  parsedManifest: unknown,
): string | undefined {
  if (typeof parsedManifest !== 'object' || parsedManifest === null) {
    return;
  }

  const outputs = (parsedManifest as { outputs?: unknown }).outputs;
  if (!Array.isArray(outputs)) {
    return;
  }

  for (const entry of outputs) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const agent = (entry as { agent?: unknown }).agent;
    if (typeof agent === 'string' && !isSyncAgent(agent)) {
      return agent;
    }
  }

  return undefined;
}

/**
 * Ensures that all target root directories exist before generated files are written.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function ensureTargetDirectories(
  targetRoots: TargetRoots,
): Effect.Effect<void, PlatformError, FileSystem> {
  const paths = listTargetRootPaths(targetRoots);

  return Effect.all(
    paths.map((directoryPath) => ensureDirectory(directoryPath)),
    { concurrency: 'unbounded', discard: true },
  );
}

/**
 * Reads the sync manifest from disk, or returns an empty manifest if none
 * exists yet.
 *
 * Any failure to read, parse, or validate falls back to an empty manifest and
 * warns that removed outputs may need manual cleanup.
 *
 * On the next sync after a fallback, current outputs are re-evaluated from
 * on-disk state, so existing matching outputs may still be reported as
 * `(unchanged)` rather than `(installed)`.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function loadSyncManifest(
  env: CommandEnv,
  manifestPath: string,
): Effect.Effect<SyncManifest, Error | PlatformError, FileSystem> {
  return Effect.gen(function* () {
    if (!(yield* pathExistsInFileSystem(manifestPath))) {
      return createSyncManifest([]);
    }

    const rawManifest = yield* readFileUtf8(manifestPath).pipe(
      Effect.catchAll(() =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            env.runtime.logWarn(
              `Could not read sync-manifest.json. Removed commands, rules, or skills may leave untracked files behind that require manual cleanup.`,
            );
          });
          return undefined;
        }),
      ),
    );

    if (rawManifest === undefined) {
      return createSyncManifest([]);
    }

    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(rawManifest);
    } catch {
      yield* Effect.sync(() => {
        env.runtime.logWarn(
          `sync-manifest.json is damaged or incomplete. Removed config entries may leave untracked files behind that require manual cleanup.`,
        );
      });
      return createSyncManifest([]);
    }

    const strictResult = syncManifestSchema.safeParse(parsedManifest);

    if (strictResult.success) {
      return strictResult.data;
    }

    const unregisteredAgent = findUnregisteredManifestAgent(parsedManifest);
    if (unregisteredAgent !== undefined) {
      return yield* Effect.fail(
        new Error(
          `sync-manifest.json references unregistered agent "${unregisteredAgent}". Remove entries for "${unregisteredAgent}" from sync-manifest.json, or delete sync-manifest.json to rebuild it on the next sync.`,
        ),
      );
    }

    yield* Effect.sync(() => {
      env.runtime.logWarn(
        `sync-manifest.json did not match the expected layout. Removed config entries may leave untracked files behind that require manual cleanup.`,
      );
    });
    return createSyncManifest([]);
  });
}

/**
 * Serializes and writes the sync manifest to manifestPath.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function saveSyncManifest(
  manifestPath: string,
  manifest: SyncManifest,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    yield* ensureDirectory(path.dirname(manifestPath));
    yield* writeTextFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  });
}

/**
 * Creates a normalized sync manifest with deterministic output ordering.
 */
export function createSyncManifest(entries: SyncManifestEntry[]): SyncManifest {
  const entriesByOutputPath = new Map<string, SyncManifestEntry>();

  for (const entry of entries) {
    entriesByOutputPath.set(entry.outputPath, entry);
  }

  return {
    version: SYNC_MANIFEST_VERSION,
    outputs: [...entriesByOutputPath.values()].sort(compareManifestEntries),
  };
}

/**
 * Returns the markdown source files found directly under a source root.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function getMarkdownFilePaths(
  rootDir: string,
): Effect.Effect<string[], Error | PlatformError, FileSystem> {
  return Effect.gen(function* () {
    yield* ensureDirectory(rootDir);
    const matches = yield* Effect.tryPromise({
      try: () => glob([path.join(rootDir, '*.md')]),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });
    return [...matches].sort();
  });
}

/**
 * Writes one markdown file after rendering its frontmatter and body content.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function writeMarkdownFile<Metadata extends Record<string, unknown>>(
  filePath: string,
  metadata: Metadata,
  body: string,
): Effect.Effect<void, PlatformError, FileSystem> {
  return writeTextFile(filePath, renderMarkdown({ metadata, body }));
}

/**
 * Computes a content hash for one artifact spec. The goal is to prevent
 * overwriting local file changes by identifying the bytes that WOULD be written
 * on the next sync. Markdown artifacts hash the exact rendered output
 * (frontmatter + body). Directory artifacts hash a sorted, serialized snapshot
 * of per-file SHA-256 hashes under the source directory. The hash is stable
 * across runs as long as the effective content is unchanged, and is used to
 * detect the `unchanged` branch.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function computeArtifactSpecContentHash(
  artifactSpec: ArtifactSpec,
): Effect.Effect<string, PlatformError, FileSystem> {
  if (artifactSpec.artifactType === 'markdown') {
    const content = renderMarkdown({
      metadata: artifactSpec.metadata,
      body: artifactSpec.body,
    });
    return Effect.succeed(createHash('sha256').update(content).digest('hex'));
  }

  return Effect.gen(function* () {
    const fileHashes = yield* computeDirectoryHashes(artifactSpec.sourceDir);
    const serialized = JSON.stringify(
      Object.entries(fileHashes).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    return createHash('sha256').update(serialized).digest('hex');
  });
}

/**
 * SHA-256 of the bytes currently on disk for this artifact spec, using the same
 * serialization as {@link computeArtifactSpecContentHash} so it can be compared
 * to the would-be-written hash. Returns `undefined` if the artifact is
 * missing or cannot be read.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function computeOnDiskArtifactContentHash(
  artifactSpec: ArtifactSpec,
): Effect.Effect<string | undefined, never, FileSystem> {
  return Effect.gen(function* () {
    if (artifactSpec.artifactType === 'markdown') {
      const filePath = artifactSpec.fileWritePath;
      if (!(yield* pathExistsInFileSystem(filePath))) {
        return undefined;
      }
      const content = yield* readFileUtf8(filePath);
      return createHash('sha256').update(content).digest('hex');
    }

    if (!(yield* pathExistsInFileSystem(artifactSpec.managedArtifactPath))) {
      return undefined;
    }
    const fileHashes = yield* computeDirectoryHashes(
      artifactSpec.managedArtifactPath,
    );
    const serialized = JSON.stringify(
      Object.entries(fileHashes).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    return createHash('sha256').update(serialized).digest('hex');
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
}

/**
 * On-disk path that must exist for an artifact spec to be treated as already materialized.
 * Matches what `writeArtifactSpec` creates: markdown artifacts use `fileWritePath`
 * (the file), which can differ from `managedArtifactPath` when that path names a
 * parent directory (e.g. Cursor commands). Directory artifacts use
 * `managedArtifactPath` as the copy root.
 */
function getArtifactSpecMaterializedPath(artifactSpec: ArtifactSpec): string {
  return artifactSpec.artifactType === 'markdown'
    ? artifactSpec.fileWritePath
    : artifactSpec.managedArtifactPath;
}

/**
 * Determines the applied change type by comparing on-disk bytes to the
 * would-be-written hash (manifest does not store content hashes).
 *
 * - `unchanged`: the artifact path exists and on-disk content hashes to the
 *   desired value.
 * - `installed`: the artifact path does not exist on disk.
 * - `updated`: the artifact exists but on-disk content does not match.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function detectAppliedChangeType(input: {
  artifactSpec: ArtifactSpec;
  desiredContentHash: string;
}): Effect.Effect<SyncAppliedChangeType, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const artifactExists = yield* pathExistsInFileSystem(
      getArtifactSpecMaterializedPath(input.artifactSpec),
    );

    if (!artifactExists) {
      return 'installed';
    }

    const onDiskHash = yield* computeOnDiskArtifactContentHash(
      input.artifactSpec,
    );
    if (onDiskHash === input.desiredContentHash) {
      return 'unchanged';
    }

    return 'updated';
  });
}

/**
 * Applies one sync item: computes a content hash per target, decides the
 * applied change type, and writes the output iff the change type is not
 * `unchanged`.
 */
function applyDesiredSyncSpec(
  desiredSpec: DesiredSyncSpec,
): Effect.Effect<AppliedSyncResult, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const directoryHashCache = new Map<string, string>();

    const changes: ItemSyncChange[] = [];

    for (const artifactSpec of desiredSpec.artifactSpecs) {
      let desiredContentHash: string;
      if (artifactSpec.artifactType === 'directory') {
        const cached = directoryHashCache.get(artifactSpec.sourceDir);
        if (cached !== undefined) {
          desiredContentHash = cached;
        } else {
          desiredContentHash =
            yield* computeArtifactSpecContentHash(artifactSpec);
          directoryHashCache.set(artifactSpec.sourceDir, desiredContentHash);
        }
      } else {
        desiredContentHash =
          yield* computeArtifactSpecContentHash(artifactSpec);
      }

      const changeType = yield* detectAppliedChangeType({
        artifactSpec,
        desiredContentHash,
      });

      changes.push({
        artifactSpec,
        agent: parseSyncAgent(artifactSpec.agent),
        changeType,
      });
    }

    for (const change of changes) {
      if (change.changeType === 'unchanged') {
        continue;
      }
      yield* writeArtifactSpec(change.artifactSpec);
    }

    return {
      desiredSpec,
      changes,
    };
  });
}

/**
 * Writes one artifact spec to its output path, either as a markdown file or a directory copy.
 */
function writeArtifactSpec(
  artifactSpec: ArtifactSpec,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    if (artifactSpec.artifactType === 'markdown') {
      yield* writeMarkdownFile(
        artifactSpec.fileWritePath,
        artifactSpec.metadata,
        artifactSpec.body,
      );
      return;
    }

    yield* copyDirectoryContents(
      artifactSpec.sourceDir,
      artifactSpec.managedArtifactPath,
    );
  });
}

export function buildDesiredSyncSpecs(
  env: CommandEnv,
): Effect.Effect<DesiredSyncSpec[], Error | PlatformError, FileSystem> {
  return Effect.gen(function* () {
    const commandSpecs = yield* buildCommandSyncSpecs(env);
    const ruleSpecs = yield* buildRuleSyncSpecs(env);
    const skillSpecs = yield* buildSkillSyncSpecs(env);
    return [...commandSpecs, ...ruleSpecs, ...skillSpecs];
  });
}

/**
 * Builds sync specs for command sources after validating their frontmatter.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function buildCommandSyncSpecs(
  env: CommandEnv,
): Effect.Effect<DesiredSyncSpec[], Error | PlatformError, FileSystem> {
  const { context, runtime } = env;
  const { targetRoots } = context;

  return Effect.gen(function* () {
    const commandFiles = yield* getMarkdownFilePaths(
      context.sourceRoots.commands,
    );

    const desiredSpecs: DesiredSyncSpec[] = [];

    for (const filePath of commandFiles) {
      const rawContent = yield* readFileUtf8(filePath);

      const { metadata, body } = parseMdWithFrontmatter(rawContent);

      const commandMetadata = validateFrontmatter(runtime, {
        filePath,
        metadata,
        schema: commandFrontmatterSchema,
      });

      if (!commandMetadata) {
        continue;
      }

      const commandName = commandMetadata.name;
      const artifactSpecs = buildCommandArtifactSpecsByAgent(runtime, {
        filePath,
        body,
        frontmatter: commandMetadata,
        targetRoots,
      });

      if (!artifactSpecs) {
        continue;
      }

      desiredSpecs.push({
        kind: 'command',
        name: commandName,
        sourcePath: filePath,
        artifactSpecs,
      });
    }

    return desiredSpecs;
  });
}

/**
 * Builds sync specs for rule sources after validating their frontmatter.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function buildRuleSyncSpecs(
  env: CommandEnv,
): Effect.Effect<DesiredSyncSpec[], Error | PlatformError, FileSystem> {
  const { context, runtime } = env;
  const { targetRoots } = context;

  return Effect.gen(function* () {
    const ruleFiles = yield* getMarkdownFilePaths(context.sourceRoots.rules);

    const desiredSpecs: DesiredSyncSpec[] = [];

    for (const filePath of ruleFiles) {
      const fileName = path.basename(filePath, '.md');
      const rawContent = yield* readFileUtf8(filePath);
      const { metadata, body } = parseMdWithFrontmatter(rawContent);
      const ruleMetadata = validateFrontmatter(runtime, {
        filePath,
        metadata,
        schema: ruleFrontmatterSchema,
      });

      if (!ruleMetadata) {
        continue;
      }

      const artifactSpecs = buildRuleArtifactSpecsByAgent(runtime, {
        filePath,
        body,
        frontmatter: ruleMetadata,
        targetRoots,
      });

      if (!artifactSpecs) {
        continue;
      }

      desiredSpecs.push({
        kind: 'rule',
        name: fileName,
        sourcePath: filePath,
        artifactSpecs,
      });
    }

    return desiredSpecs;
  });
}

/**
 * Builds sync specs for local skill directories.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function buildSkillSyncSpecs(
  env: CommandEnv,
): Effect.Effect<DesiredSyncSpec[], PlatformError, FileSystem> {
  const { context } = env;
  const { targetRoots } = context;

  return Effect.gen(function* () {
    yield* ensureDirectory(context.sourceRoots.skills);

    const fs = yield* FileSystem;
    const entryNames = yield* fs.readDirectory(context.sourceRoots.skills);

    const desiredSpecs: DesiredSyncSpec[] = [];

    for (const entryName of entryNames) {
      const entryPath = path.join(context.sourceRoots.skills, entryName);
      const info = yield* fs.stat(entryPath);

      if (info.type !== 'Directory') {
        continue;
      }

      const sourceDir = entryPath;

      desiredSpecs.push({
        kind: 'skill',
        name: entryName,
        sourcePath: sourceDir,
        artifactSpecs: SYNC_AGENTS.map((agent) =>
          AGENT_DEFINITIONS[agent].skill.buildArtifactSpec({
            input: {
              name: entryName,
              sourceDir,
            },
            targetRoots,
          }),
        ),
      });
    }

    return desiredSpecs;
  });
}

/**
 * Clears targetDir and copies all direct entries from sourceDir into it.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    yield* emptyDirectory(targetDir);

    const fs = yield* FileSystem;
    const entryNames = yield* fs.readDirectory(sourceDir);

    for (const entryName of entryNames) {
      yield* fs.copy(
        path.join(sourceDir, entryName),
        path.join(targetDir, entryName),
      );
    }
  });
}

/**
 * Collects the syncable and skipped items after analyzing output namespace conflicts.
 */
export function prepareSyncChanges(input: {
  previousManifest: SyncManifest;
  desiredSpecs: DesiredSyncSpec[];
}): SyncChanges {
  const {
    syncableSpecs,
    skippedSpecs,
    skippedOwnershipKeys,
    desiredOutputPaths,
  } = collectSyncability(input.desiredSpecs);
  const { removedEntries, preservedEntries } = partitionManifestEntries(
    input.previousManifest.outputs,
    {
      desiredOutputPaths,
      skippedOwnershipKeys,
    },
  );

  return {
    syncableSpecs,
    skippedSpecs,
    desiredOutputPaths,
    removedEntries,
    preservedEntries,
  };
}

export function applySyncChanges(
  changes: SyncChanges,
): Effect.Effect<SyncApplyResult, PlatformError, FileSystem> {
  return Effect.gen(function* () {
    yield* removeStaleOutputs(changes.removedEntries);

    const appliedSpecs: AppliedSyncResult[] = [];

    for (const desiredSpec of changes.syncableSpecs) {
      appliedSpecs.push(yield* applyDesiredSyncSpec(desiredSpec));
    }

    return {
      appliedSpecs,
      removedEntries: changes.removedEntries,
    };
  });
}

/**
 * Collects the syncable and skipped specs after analyzing output namespace conflicts.
 */
function collectSyncability(specs: DesiredSyncSpec[]): SyncabilityResult {
  const candidates: DesiredSpecCandidate[] = [];
  const ownershipMap = new Map<OwnershipKey, DesiredArtifactCandidate[]>();

  for (const spec of specs) {
    const candidate = {
      desiredSpec: spec,
      artifactCandidates: spec.artifactSpecs.map((artifactSpec) => ({
        artifactSpec,
        ownershipKey: deriveOwnershipKeyForArtifactSpec(spec, artifactSpec),
        artifactPath: artifactSpec.managedArtifactPath,
        conflictDescriptions: [],
      })),
    };

    candidates.push(candidate);

    for (const artifactCandidate of candidate.artifactCandidates) {
      const existingOwners = ownershipMap.get(artifactCandidate.ownershipKey);

      if (existingOwners) {
        existingOwners.push(artifactCandidate);
      } else {
        ownershipMap.set(artifactCandidate.ownershipKey, [artifactCandidate]);
      }
    }
  }

  for (const [ownershipKey, owners] of ownershipMap) {
    if (owners.length < 2) {
      continue;
    }

    const conflictDescription = describeOwnershipKey(ownershipKey);

    for (const owner of owners) {
      owner.conflictDescriptions.push(conflictDescription);
    }
  }

  const skippedSpecs: SkippedSyncResult[] = [];
  const skippedOwnershipKeys = new Set<OwnershipKey>();
  const syncableSpecs: DesiredSyncSpec[] = [];
  const desiredOutputPaths = new Set<string>();

  for (const candidate of candidates) {
    const skippedArtifactCandidates = candidate.artifactCandidates.filter(
      (artifactCandidate) => artifactCandidate.conflictDescriptions.length > 0,
    );
    const syncableArtifactCandidates = candidate.artifactCandidates.filter(
      (artifactCandidate) =>
        artifactCandidate.conflictDescriptions.length === 0,
    );

    if (skippedArtifactCandidates.length > 0) {
      skippedSpecs.push({
        desiredSpec: candidate.desiredSpec,
        conflictDescriptions: [
          ...new Set(
            skippedArtifactCandidates.flatMap(
              (artifactCandidate) => artifactCandidate.conflictDescriptions,
            ),
          ),
        ].sort(),
      });

      for (const artifactCandidate of skippedArtifactCandidates) {
        skippedOwnershipKeys.add(artifactCandidate.ownershipKey);
      }
    }

    if (syncableArtifactCandidates.length === 0) {
      continue;
    }

    syncableSpecs.push({
      ...candidate.desiredSpec,
      artifactSpecs: syncableArtifactCandidates.map(
        (artifactCandidate) => artifactCandidate.artifactSpec,
      ),
    });

    for (const artifactCandidate of syncableArtifactCandidates) {
      desiredOutputPaths.add(artifactCandidate.artifactPath);
    }
  }

  return {
    syncableSpecs,
    skippedSpecs,
    skippedOwnershipKeys,
    desiredOutputPaths,
  };
}

/**
 * Converts applied sync specs into manifest entries for desired outputs.
 */
export function collectManifestEntriesFromApplied(
  appliedSpecs: AppliedSyncResult[],
): SyncManifestEntry[] {
  return appliedSpecs.flatMap((appliedSpec) =>
    appliedSpec.changes.map((change) => ({
      agent: change.agent,
      kind: appliedSpec.desiredSpec.kind,
      name: appliedSpec.desiredSpec.name,
      outputPath: change.artifactSpec.managedArtifactPath,
    })),
  );
}

/**
 * Partitions previous manifest entries into removed and preserved entries.
 */
function partitionManifestEntries(
  manifestEntries: SyncManifestEntry[],
  input: {
    desiredOutputPaths: ReadonlySet<string>;
    skippedOwnershipKeys: ReadonlySet<OwnershipKey>;
  },
): PartitionedManifestEntries {
  const removedEntries: SyncManifestEntry[] = [];
  const preservedEntries: SyncManifestEntry[] = [];

  for (const entry of manifestEntries) {
    if (input.desiredOutputPaths.has(entry.outputPath)) {
      continue;
    }

    if (
      input.skippedOwnershipKeys.has(deriveOwnershipKeyForManifestEntry(entry))
    ) {
      preservedEntries.push(entry);
    } else {
      removedEntries.push(entry);
    }
  }

  return {
    removedEntries,
    preservedEntries,
  };
}

/**
 * Removes stale dry-ai-managed outputs that are no longer part of the desired sync state.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
function removeStaleOutputs(
  removedEntries: SyncManifestEntry[],
): Effect.Effect<void, PlatformError, FileSystem> {
  return Effect.forEach(
    removedEntries,
    (entry) => removePath(entry.outputPath),
    { discard: true },
  );
}

/**
 * Renders a sync summary grouped by agent, item kind, and skipped conflicts.
 */
export function renderSyncReport(
  result: SyncApplyResult,
  changes: SyncChanges,
): string {
  const agentSections = SYNC_AGENTS.map((agent) =>
    renderAgentSyncSection(
      getAgentLabel(agent),
      collectAgentReportedSyncChanges(
        result.appliedSpecs,
        result.removedEntries,
        agent,
      ),
    ),
  ).filter((section): section is string => section !== undefined);

  const sections =
    agentSections.length === 0
      ? [`${chalk.bold.cyan('Applied changes:')} ${chalk.green('None')}`]
      : [chalk.bold.cyan('Applied changes:'), ...agentSections];

  if (changes.skippedSpecs.length === 0) {
    sections.push(
      `${chalk.bold.green('Skipped conflicts:')} ${chalk.green('None')}`,
    );
  } else {
    const skippedLines = changes.skippedSpecs
      .slice()
      .sort((left, right) =>
        formatDesiredSyncSpecLabel(left.desiredSpec).localeCompare(
          formatDesiredSyncSpecLabel(right.desiredSpec),
        ),
      )
      .map((skippedResult) =>
        [
          `- ${chalk.red(formatDesiredSyncSpecLabel(skippedResult.desiredSpec))}`,
          `  * ${chalk.bold.red('due to:')} ${chalk.yellow(skippedResult.conflictDescriptions.join(', '))}`,
        ].join('\n'),
      );
    sections.push(
      `${chalk.bold.red('Skipped conflicts:')}\n${skippedLines.join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

/**
 * Collects the reported sync changes relevant to one agent.
 */
function collectAgentReportedSyncChanges(
  appliedResults: AppliedSyncResult[],
  removedEntries: SyncManifestEntry[],
  agent: SyncAgent,
): ReportedAgentSyncChange[] {
  const appliedChanges = appliedResults.flatMap((appliedResult) =>
    appliedResult.changes
      .filter(
        (change) => change.agent === agent && change.changeType !== 'unchanged',
      )
      .map((change) => ({
        kind: appliedResult.desiredSpec.kind,
        name: appliedResult.desiredSpec.name,
        changeType: change.changeType,
      })),
  );
  const removedChanges = removedEntries
    .filter((entry) => entry.agent === agent)
    .map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      changeType: 'removed' as const,
    }));

  return [...appliedChanges, ...removedChanges];
}

/**
 * Renders the synced items for one agent grouped by item kind.
 * Returns `undefined` when there is nothing to report for this agent
 * (so empty agent headings are omitted from the summary).
 */
function renderAgentSyncSection(
  agentLabel: string,
  reportedChanges: ReportedAgentSyncChange[],
): string | undefined {
  const kindSections = [
    renderKindSyncLine('commands', 'command', reportedChanges),
    renderKindSyncLine('rules', 'rule', reportedChanges),
    renderKindSyncLine('skills', 'skill', reportedChanges),
  ].filter((section) => section !== undefined);

  if (kindSections.length === 0) {
    return undefined;
  }

  return [`- ${colorAgentLabel(agentLabel)}`, ...kindSections].join('\n');
}

/**
 * Renders one sync summary section for a specific item kind.
 */
function renderKindSyncLine(
  label: string,
  kind: SyncItemKind,
  reportedChanges: ReportedAgentSyncChange[],
): string | undefined {
  const matchingChanges = reportedChanges
    .filter((item) => item.kind === kind)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));

  if (matchingChanges.length === 0) {
    return undefined;
  }

  return [
    `  * ${colorKindLabel(label)}`,
    ...matchingChanges.map(renderReportedSyncChangeLine),
  ].join('\n');
}

/**
 * Returns the styled agent label used in the sync summary.
 */
function colorAgentLabel(agentLabel: string): string {
  return chalk.bold.blue(agentLabel);
}

/**
 * Returns the styled item-kind label used in the sync summary.
 */
function colorKindLabel(label: string): string {
  return chalk.bold.yellow(label);
}

/**
 * Returns the styled change-type label used in the sync summary.
 */
function colorChangeType(changeType: SyncChangeType): string {
  if (changeType === 'installed') {
    return chalk.green(changeType);
  }

  if (changeType === 'removed') {
    return chalk.red(changeType);
  }

  return chalk.yellow(changeType);
}

/**
 * Renders one styled applied-item line in the sync summary.
 */
function renderReportedSyncChangeLine(
  reportedChange: ReportedAgentSyncChange,
): string {
  return `    - ${chalk.whiteBright(reportedChange.name)} (${colorChangeType(reportedChange.changeType)})`;
}

/**
 * Returns a readable label for one sync spec in conflict warnings.
 */
function formatDesiredSyncSpecLabel(spec: DesiredSyncSpec): string {
  return `${spec.kind} "${spec.name}" from ${spec.sourcePath}`;
}

/**
 * Orders manifest entries deterministically for stable on-disk state.
 */
function compareManifestEntries(
  left: SyncManifestEntry,
  right: SyncManifestEntry,
): number {
  return [left.agent, left.kind, left.name, left.outputPath]
    .join('\0')
    .localeCompare(
      [right.agent, right.kind, right.name, right.outputPath].join('\0'),
    );
}
