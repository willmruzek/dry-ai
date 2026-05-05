import { createHash } from 'node:crypto';
import path from 'node:path';

import { Chalk } from 'chalk';
import fs from 'fs-extra';
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
import type { CLIRuntime } from './command-env.js';
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
 */
export async function ensureTargetDirectories(
  targetRoots: TargetRoots,
): Promise<void> {
  await Promise.all(
    listTargetRootPaths(targetRoots).map((dir) => fs.ensureDir(dir)),
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
 * Serializes and writes the sync manifest to manifestPath.
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
 */
async function getMarkdownFilePaths(rootDir: string): Promise<string[]> {
  await fs.ensureDir(rootDir);

  const matches = await glob([path.join(rootDir, '*.md')]);

  return matches.sort();
}

/**
 * Writes one markdown file after rendering its frontmatter and body content.
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
 * Computes a content hash for one artifact spec. The goal is to prevent
 * overwriting local file changes by identifying the bytes that WOULD be written
 * on the next sync. Markdown artifacts hash the exact rendered output
 * (frontmatter + body). Directory artifacts hash a sorted, serialized snapshot
 * of per-file SHA-256 hashes under the source directory. The hash is stable
 * across runs as long as the effective content is unchanged, and is used to
 * detect the `unchanged` branch.
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
 * SHA-256 of the bytes currently on disk for this artifact spec, using the same
 * serialization as {@link computeArtifactSpecContentHash} so it can be compared
 * to the would-be-written hash. Returns `undefined` if the artifact is
 * missing or cannot be read.
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
 * Applies one sync item: computes a content hash per target, decides the
 * applied change type, and writes the output iff the change type is not
 * `unchanged`.
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
 * Builds sync specs for command sources after validating their frontmatter.
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
 * Builds sync specs for rule sources after validating their frontmatter.
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
 * Builds sync specs for local skill directories.
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
 */
async function removeStaleOutputs(
  removedEntries: SyncManifestEntry[],
): Promise<void> {
  for (const entry of removedEntries) {
    await fs.remove(entry.outputPath);
  }
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
