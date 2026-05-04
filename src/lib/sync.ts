import { createHash } from 'node:crypto';
import path from 'node:path';

import { Chalk } from 'chalk';
import fs from 'fs-extra';
import { glob } from 'glob';
import { z } from 'zod';

import type { CLIRuntime } from '../cli.js';

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
import type { AgentsContext } from './context.js';
import {
  commandFrontmatterSchema,
  parseMdWithFrontmatter,
  renderMarkdown,
  ruleFrontmatterSchema,
  validateFrontmatter,
} from './frontmatter.js';
import { computeDirectoryHashes } from './skills.js';

/** Written to `sync-manifest.json`; bump when the manifest shape changes. */
export const SYNC_MANIFEST_VERSION = 2 as const;

type SyncAppliedChangeType = 'installed' | 'updated' | 'unchanged';
type SyncChangeType = SyncAppliedChangeType | 'removed';

const chalk = new Chalk({ level: 3 });

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
 * Validate that a string is a recognized sync agent and return it.
 *
 * @param agent - The agent identifier to validate
 * @returns The validated `SyncAgent` string
 * @throws Error if `agent` is not a supported sync agent
 */
function parseSyncAgent(agent: string): SyncAgent {
  if (isSyncAgent(agent)) {
    return agent;
  }

  throw new Error(`Unsupported sync agent: ${agent}`);
}

/**
 * Derives the ownership key claimed by an artifact spec for conflict detection.
 *
 * @param desiredSpec - Desired sync spec supplying the `kind` and `name` used in the key
 * @param artifactSpec - Artifact spec supplying the `agent` and `managedArtifactPath` used as the `outputPath`
 * @returns The ownership key composed of `agent`, `kind`, `name`, and `outputPath` that identifies claimed ownership of the artifact
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
 * Derives the ownership key that uniquely identifies the owner of a manifest entry.
 *
 * @param manifestEntry - The manifest entry whose `agent`, `kind`, `name`, and `outputPath` are used
 * @returns The ownership key constructed from the entry's `agent`, `kind`, `name`, and `outputPath`
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
 * Finds the first agent string in a parsed manifest that is not a registered SyncAgent.
 *
 * Scans `parsedManifest.outputs` (if present and an array) and returns the first `agent`
 * value that is a string but fails `isSyncAgent`.
 *
 * @param parsedManifest - The parsed manifest JSON to inspect
 * @returns The unregistered agent string if found, otherwise `undefined`
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
 */
export async function ensureTargetDirectories(
  targetRoots: TargetRoots,
): Promise<void> {
  await Promise.all(
    listTargetRootPaths(targetRoots).map((dir) => fs.ensureDir(dir)),
  );
}

/**
 * Load the sync manifest from disk; fall back to an empty manifest when the file is missing, unreadable, or does not match the expected layout.
 *
 * @param manifestPath - Filesystem path to the sync-manifest.json file
 * @returns The validated SyncManifest, or an empty manifest when no valid file can be read
 * @throws If the manifest references an unregistered agent (instructs removal of those entries or deletion of the manifest)
 */
export async function loadSyncManifest(
  manifestPath: string,
  runtime: CLIRuntime,
): Promise<SyncManifest> {
  if (!(await fs.pathExists(manifestPath))) {
    return createSyncManifest([]);
  }

  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestPath, 'utf8');
  } catch {
    runtime.logWarn(
      `Could not read sync-manifest.json. Removed commands, rules, or skills may leave untracked files behind that require manual cleanup.`,
    );
    return createSyncManifest([]);
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch {
    runtime.logWarn(
      `sync-manifest.json is damaged or incomplete. Removed config entries may leave untracked files behind that require manual cleanup.`,
    );
    return createSyncManifest([]);
  }

  const strictResult = syncManifestSchema.safeParse(parsedManifest);

  if (strictResult.success) {
    return strictResult.data;
  }

  const unregisteredAgent = findUnregisteredManifestAgent(parsedManifest);
  if (unregisteredAgent !== undefined) {
    throw new Error(
      `sync-manifest.json references unregistered agent "${unregisteredAgent}". Remove entries for "${unregisteredAgent}" from sync-manifest.json, or delete sync-manifest.json to rebuild it on the next sync.`,
    );
  }

  runtime.logWarn(
    `sync-manifest.json did not match the expected layout. Removed config entries may leave untracked files behind that require manual cleanup.`,
  );
  return createSyncManifest([]);
}

/**
 * Write the sync manifest to disk at the given path.
 *
 * Ensures the manifest file's parent directory exists, then writes the manifest
 * as pretty-printed JSON (2-space indentation) with a trailing newline.
 *
 * @param manifestPath - Filesystem path where the manifest will be written
 * @param manifest - The manifest object to serialize (including `version` and `outputs`)
 */
export async function saveSyncManifest(
  manifestPath: string,
  manifest: SyncManifest,
): Promise<void> {
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Build a canonical sync manifest from a list of manifest entries.
 *
 * Duplicate entries sharing the same `outputPath` are deduplicated by keeping the last
 * entry for that path, and the resulting manifest outputs are sorted deterministically.
 *
 * @param entries - Manifest entries to include (later entries override earlier ones for the same `outputPath`)
 * @returns A sync manifest object with the current manifest version and a deterministically ordered `outputs` array
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
 * List markdown files located directly under a directory.
 *
 * @returns Sorted array of file paths for `*.md` files found immediately inside `rootDir`
 */
async function getMarkdownFilePaths(rootDir: string): Promise<string[]> {
  await fs.ensureDir(rootDir);

  const matches = await glob([path.join(rootDir, '*.md')]);

  return matches.sort();
}

/**
 * Render `metadata` as frontmatter, combine it with `body`, ensure the parent directory exists, and write the result to `filePath`.
 *
 * @param filePath - Destination path for the rendered markdown file
 * @param metadata - Frontmatter object to include at the top of the file
 * @param body - Markdown body content placed after the frontmatter
 */
async function writeMarkdownFile<Metadata extends Record<string, unknown>>(
  filePath: string,
  metadata: Metadata,
  body: string,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, renderMarkdown({ metadata, body }), 'utf8');
}

/**
 * Compute a stable content hash representing the bytes that would be written for the given artifact spec.
 *
 * For markdown artifacts the hash is derived from the rendered output (frontmatter + body). For directory artifacts the hash is derived from a deterministic snapshot of per-file SHA-256 hashes under the source directory.
 *
 * @returns A hex-encoded SHA-256 hash of the artifact's would-be-on-disk content
 */
async function computeArtifactSpecContentHash(
  artifactSpec: ArtifactSpec,
): Promise<string> {
  if (artifactSpec.artifactType === 'markdown') {
    const content = renderMarkdown({
      metadata: artifactSpec.metadata,
      body: artifactSpec.body,
    });
    return createHash('sha256').update(content).digest('hex');
  }

  const fileHashes = await computeDirectoryHashes(artifactSpec.sourceDir);
  const serialized = JSON.stringify(
    Object.entries(fileHashes).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Compute the SHA-256 hex digest for an artifact's on-disk content.
 *
 * @param artifactSpec - The artifact spec whose materialized content to hash
 * @returns The SHA-256 hex digest of the on-disk content if present and readable, `undefined` otherwise.
 */
async function computeOnDiskArtifactContentHash(
  artifactSpec: ArtifactSpec,
): Promise<string | undefined> {
  if (artifactSpec.artifactType === 'markdown') {
    const filePath = artifactSpec.fileWritePath;
    try {
      if (!(await fs.pathExists(filePath))) {
        return undefined;
      }
      const content = await fs.readFile(filePath, 'utf8');
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return undefined;
    }
  }

  try {
    if (!(await fs.pathExists(artifactSpec.managedArtifactPath))) {
      return undefined;
    }
    const fileHashes = await computeDirectoryHashes(
      artifactSpec.managedArtifactPath,
    );
    const serialized = JSON.stringify(
      Object.entries(fileHashes).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );
    return createHash('sha256').update(serialized).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Return the on-disk path whose existence indicates the artifact spec is materialized.
 *
 * @returns The path that must exist for this artifact: `fileWritePath` for markdown artifacts, otherwise `managedArtifactPath`.
 */
function getArtifactSpecMaterializedPath(artifactSpec: ArtifactSpec): string {
  return artifactSpec.artifactType === 'markdown'
    ? artifactSpec.fileWritePath
    : artifactSpec.managedArtifactPath;
}

/**
 * Determine whether an artifact will be installed, updated, or left unchanged by comparing the desired content hash with on-disk content.
 *
 * @returns `'installed'` if the artifact path does not exist on disk, `'unchanged'` if the on-disk content hash equals the desired hash, `'updated'` otherwise.
 */
async function detectAppliedChangeType(input: {
  artifactSpec: ArtifactSpec;
  desiredContentHash: string;
}): Promise<SyncAppliedChangeType> {
  const artifactExists = await fs.pathExists(
    getArtifactSpecMaterializedPath(input.artifactSpec),
  );

  if (!artifactExists) {
    return 'installed';
  }

  const onDiskHash = await computeOnDiskArtifactContentHash(input.artifactSpec);
  if (onDiskHash === input.desiredContentHash) {
    return 'unchanged';
  }

  return 'updated';
}

/**
 * Applies a desired sync spec by computing content hashes for its artifact specs,
 * determining each artifact's applied change type, and writing outputs for artifacts
 * that are not `unchanged`.
 *
 * @param desiredSpec - The desired sync specification containing artifact specs to apply
 * @returns The applied sync result containing the original `desiredSpec` and an array of per-artifact changes. Each change includes the parsed agent, the artifact spec, and the `changeType` (`installed`, `updated`, or `unchanged`).
 */
async function applyDesiredSyncSpec(
  desiredSpec: DesiredSyncSpec,
): Promise<AppliedSyncResult> {
  const directoryHashCache = new Map<string, Promise<string>>();

  const changes = await Promise.all(
    desiredSpec.artifactSpecs.map(
      async (artifactSpec): Promise<ItemSyncChange> => {
        let desiredContentHash: string;
        if (artifactSpec.artifactType === 'directory') {
          const cachedHashPromise = directoryHashCache.get(
            artifactSpec.sourceDir,
          );
          const contentHashPromise =
            cachedHashPromise ?? computeArtifactSpecContentHash(artifactSpec);

          if (!cachedHashPromise) {
            directoryHashCache.set(artifactSpec.sourceDir, contentHashPromise);
          }

          desiredContentHash = await contentHashPromise;
        } else {
          desiredContentHash =
            await computeArtifactSpecContentHash(artifactSpec);
        }

        const changeType = await detectAppliedChangeType({
          artifactSpec,
          desiredContentHash,
        });

        return {
          artifactSpec,
          agent: parseSyncAgent(artifactSpec.agent),
          changeType,
        };
      },
    ),
  );

  for (const change of changes) {
    if (change.changeType === 'unchanged') {
      continue;
    }
    await writeArtifactSpec(change.artifactSpec);
  }

  return {
    desiredSpec,
    changes,
  };
}

/**
 * Writes one artifact spec to its output path, either as a markdown file or a directory copy.
 */
async function writeArtifactSpec(artifactSpec: ArtifactSpec): Promise<void> {
  if (artifactSpec.artifactType === 'markdown') {
    await writeMarkdownFile(
      artifactSpec.fileWritePath,
      artifactSpec.metadata,
      artifactSpec.body,
    );
    return;
  }

  await copyDirectoryContents(
    artifactSpec.sourceDir,
    artifactSpec.managedArtifactPath,
  );
}

/**
 * Assembles desired sync specifications for all commands, rules, and skills found in the source roots.
 *
 * @param context - Context containing source and target root locations used to discover artifacts
 * @param runtime - Runtime utilities and configuration used while building specs
 * @returns An array of DesiredSyncSpec objects describing the desired artifacts to be synchronized (commands, rules, and skills)
 */
export async function buildDesiredSyncSpecs(
  context: AgentsContext,
  runtime: CLIRuntime,
): Promise<DesiredSyncSpec[]> {
  return [
    ...(await buildCommandSyncSpecs(context, runtime)),
    ...(await buildRuleSyncSpecs(context, runtime)),
    ...(await buildSkillSyncSpecs(context)),
  ];
}

/**
 * Builds desired sync specs for command markdown files in the commands source root.
 *
 * For each markdown file directly under context.sourceRoots.commands, parses and validates
 * its frontmatter against the command schema and, if valid, produces artifact specs per agent.
 * Files with invalid frontmatter or that do not produce artifact specs are skipped.
 *
 * @param context - Provides sourceRoots (commands) and targetRoots used to construct artifact specs
 * @param runtime - Runtime utilities used for validation and agent-specific builders
 * @returns An array of DesiredSyncSpec objects for commands that passed validation and produced artifact specs
 */
async function buildCommandSyncSpecs(
  context: AgentsContext,
  runtime: CLIRuntime,
): Promise<DesiredSyncSpec[]> {
  const { targetRoots } = context;

  const commandFiles = await getMarkdownFilePaths(context.sourceRoots.commands);

  const desiredSpecs: DesiredSyncSpec[] = [];

  for (const filePath of commandFiles) {
    const rawContent = await fs.readFile(filePath, 'utf8');

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
}

/**
 * Builds desired sync specifications for rule markdown files under the rules source root.
 *
 * Scans rule Markdown files, parses and validates their frontmatter, and converts each valid file into a DesiredSyncSpec with artifact specs for configured agents. Files whose frontmatter fails validation or that produce no artifact specs are skipped.
 *
 * @returns An array of DesiredSyncSpec objects for rule sources that passed validation and produced artifact specs
 */
async function buildRuleSyncSpecs(
  context: AgentsContext,
  runtime: CLIRuntime,
): Promise<DesiredSyncSpec[]> {
  const { targetRoots } = context;

  const ruleFiles = await getMarkdownFilePaths(context.sourceRoots.rules);

  const desiredSpecs: DesiredSyncSpec[] = [];

  for (const filePath of ruleFiles) {
    const fileName = path.basename(filePath, '.md');
    const rawContent = await fs.readFile(filePath, 'utf8');
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
}

/**
 * Collects desired sync specs for each skill subdirectory found under the skills source root.
 *
 * Ignores non-directory entries and produces one DesiredSyncSpec per skill directory, where
 * each spec's `artifactSpecs` contains artifact specifications built for every supported agent.
 *
 * @param context - AgentsContext containing `sourceRoots.skills` (the skills root to scan) and `targetRoots` used when building artifact specs
 * @returns An array of DesiredSyncSpec objects, one per skill directory found under `sourceRoots.skills`
 */
async function buildSkillSyncSpecs(
  context: AgentsContext,
): Promise<DesiredSyncSpec[]> {
  const { targetRoots } = context;

  await fs.ensureDir(context.sourceRoots.skills);

  const entries = await fs.readdir(context.sourceRoots.skills, {
    withFileTypes: true,
  });

  const desiredSpecs: DesiredSyncSpec[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceDir = path.join(context.sourceRoots.skills, entry.name);

    desiredSpecs.push({
      kind: 'skill',
      name: entry.name,
      sourcePath: sourceDir,
      artifactSpecs: SYNC_AGENTS.map((agent) =>
        AGENT_DEFINITIONS[agent].skill.buildArtifactSpec({
          input: {
            name: entry.name,
            sourceDir,
          },
          targetRoots,
        }),
      ),
    });
  }

  return desiredSpecs;
}

/**
 * Clears targetDir and copies all direct entries from sourceDir into it.
 */
async function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  await fs.emptyDir(targetDir);
  const entryNames = await fs.readdir(sourceDir);

  for (const entryName of entryNames) {
    await fs.copy(
      path.join(sourceDir, entryName),
      path.join(targetDir, entryName),
    );
  }
}

/**
 * Determine which desired specs can be applied and which must be skipped due to ownership/output conflicts, and partition previous manifest entries for removal or preservation.
 *
 * @param input.previousManifest - The previously saved sync manifest whose outputs will be compared against desired outputs
 * @param input.desiredSpecs - The desired sync specifications to evaluate for syncability
 * @returns An object describing planned changes:
 * - `syncableSpecs`: desired specs with conflict-free artifact specs that should be applied
 * - `skippedSpecs`: desired specs that were skipped due to ownership conflicts, each with conflict descriptions
 * - `desiredOutputPaths`: set of output paths that remain desired after conflict resolution
 * - `removedEntries`: manifest entries whose outputs are no longer desired and should be removed
 * - `preservedEntries`: manifest entries preserved because their ownership keys were skipped
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

/**
 * Applies a prepared set of sync changes: removes stale outputs and materializes each syncable desired spec.
 *
 * @param changes - The prepared sync changes containing `syncableSpecs` to apply and `removedEntries` to delete.
 * @returns An object with `appliedSpecs` — results for each applied desired spec — and `removedEntries` that were removed. 
 */
export async function applySyncChanges(
  changes: SyncChanges,
): Promise<SyncApplyResult> {
  await removeStaleOutputs(changes.removedEntries);

  const appliedSpecs: AppliedSyncResult[] = [];

  for (const desiredSpec of changes.syncableSpecs) {
    appliedSpecs.push(await applyDesiredSyncSpec(desiredSpec));
  }

  return {
    appliedSpecs,
    removedEntries: changes.removedEntries,
  };
}

/**
 * Analyze desired specs for ownership conflicts and split them into syncable and skipped groups.
 *
 * @param specs - The desired sync specifications to analyze for ownership collisions.
 * @returns An object containing:
 *   - `syncableSpecs`: desired specs where conflicting artifact specs have been removed so only non-conflicting artifact specs remain;
 *   - `skippedSpecs`: entries for specs that had one or more conflicting artifact specs, each with the original `desiredSpec` and a sorted, deduplicated list of `conflictDescriptions`;
 *   - `skippedOwnershipKeys`: ownership keys that are involved in conflicts and should be preserved in the manifest;
 *   - `desiredOutputPaths`: the set of artifact output paths produced by the syncable artifact specs.
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
 * Produce manifest entries for every artifact written or kept from applied sync results.
 *
 * @returns An array of manifest entries where each entry contains the `agent`, `kind`, `name`, and `outputPath` corresponding to an applied artifact
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
 * Determines which entries from a previous sync manifest should be removed and which should be preserved.
 *
 * @param manifestEntries - The manifest's existing output entries to evaluate.
 * @param input.desiredOutputPaths - Output paths that are still desired by the new desired specs; entries with these paths are left as-is.
 * @param input.skippedOwnershipKeys - Ownership keys claimed by specs that were skipped due to conflicts; manifest entries matching these keys are preserved.
 * @returns An object with `removedEntries` — manifest entries that should be deleted, and `preservedEntries` — entries that should be retained. 
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
 */
async function removeStaleOutputs(
  removedEntries: SyncManifestEntry[],
): Promise<void> {
  for (const entry of removedEntries) {
    await fs.remove(entry.outputPath);
  }
}

/**
 * Render a human-readable sync report grouped by agent, item kind, and skipped conflicts.
 *
 * The report includes an "Applied changes" section showing per-agent changes (omitted for agents with nothing to report)
 * and a "Skipped conflicts" section listing desired specs that were not applied with their conflict descriptions.
 *
 * @param result - The outcome of applying sync changes, containing applied specs and removed entries
 * @param changes - The prepared sync changes, including skipped specs and their conflict descriptions
 * @returns A multi-line string describing applied changes per agent and any skipped conflicts
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
 * Format a single reported sync change into a styled, indented summary line.
 *
 * @param reportedChange - The reported change containing `name` and `changeType` to render
 * @returns An indented, human-readable line with the item name and its change type (styled for terminal output)
 */
function renderReportedSyncChangeLine(
  reportedChange: ReportedAgentSyncChange,
): string {
  return `    - ${chalk.whiteBright(reportedChange.name)} (${colorChangeType(reportedChange.changeType)})`;
}

/**
 * Produce a human-readable label for a desired sync spec suitable for conflict or status messages.
 *
 * @param spec - The desired sync specification to label
 * @returns A string like `kind "name" from sourcePath` identifying the spec
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
