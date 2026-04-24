import { createHash } from 'node:crypto';
import path from 'node:path';

import { Chalk } from 'chalk';
import fs from 'fs-extra';
import { glob } from 'glob';
import { z } from 'zod';

import type { CLIRuntime } from '../cli.js';

import {
  buildSyncTargets,
  createAgentCmdSyncSpec,
  createOwnershipKey,
  createAgentRuleSyncSpec,
  describeOwnershipKey,
  getAgentLabel,
  isSyncAgent,
  listTargetRootPaths,
  SYNC_AGENTS,
  SYNC_ITEM_KINDS,
  type OwnershipKey,
  type SyncAgent,
  type SyncItemKind,
  type SyncTarget,
  type TargetRoots,
} from './agents.js';
import type { AgentsContext } from './context.js';
import {
  commandFrontmatterSchema,
  parseFrontmatter,
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

type SyncItem = {
  kind: SyncItemKind;
  name: string;
  sourcePath: string;
  targets: readonly SyncTarget[];
};

type ItemSyncChange = {
  target: SyncTarget;
  agent: SyncAgent;
  changeType: SyncAppliedChangeType;
};

type AppliedSyncItem = {
  item: SyncItem;
  changes: ItemSyncChange[];
};

type ReportedAgentSyncChange = {
  kind: SyncItemKind;
  name: string;
  changeType: SyncChangeType;
};

type SkippedSyncItem = {
  item: SyncItem;
  conflictDescriptions: string[];
};

type ConflictFilterResult = {
  syncableItems: SyncItem[];
  skippedItems: SkippedSyncItem[];
};

type SyncManifestEntry = z.output<typeof syncManifestEntrySchema>;
type SyncManifest = z.output<typeof syncManifestSchema>;

/**
 * Validates and returns the agent name from a sync target, throwing if it is unrecognized.
 */
function parseSyncAgent(agent: string): SyncAgent {
  if (isSyncAgent(agent)) {
    return agent;
  }

  throw new Error(`Unsupported sync agent: ${agent}`);
}

/**
 * Writes all command, rule, and skill outputs to their target directories, then prunes any stale dry-ai-managed files from prior runs.
 */
export async function syncToTargets(
  context: AgentsContext,
  runtime: CLIRuntime,
): Promise<void> {
  const { targetRoots } = context;
  await ensureTargetDirectories(targetRoots);

  const { manifest: previousManifest, recoveryWarning } =
    await loadSyncManifest(context.syncManifestPath);
  if (recoveryWarning !== undefined) {
    runtime.logWarn(recoveryWarning);
  }
  const syncItems = [
    ...(await collectCommandSyncItems(context, runtime)),
    ...(await collectRuleSyncItems(context, runtime)),
    ...(await collectSkillSyncItems(context)),
  ];
  const { syncableItems, skippedItems } =
    collectConflictFilterResult(syncItems);
  const skippedOwnershipKeys = collectSkippedOwnershipKeys(skippedItems);
  const desiredOutputPaths = new Set(
    syncableItems.flatMap((syncItem) =>
      syncItem.targets.map((target) => target.outputPath),
    ),
  );
  const removedEntries = collectRemovedManifestEntries(
    previousManifest.outputs,
    {
      desiredOutputPaths,
      skippedOwnershipKeys,
    },
  );

  await removeStaleOutputs(removedEntries);

  const appliedItems: AppliedSyncItem[] = [];

  for (const syncItem of syncableItems) {
    appliedItems.push(await applySyncItem(syncItem));
  }

  const desiredManifestEntries =
    collectManifestEntriesFromApplied(appliedItems);
  const preservedEntries = collectPreservedManifestEntries(
    previousManifest.outputs,
    {
      desiredOutputPaths,
      skippedOwnershipKeys,
    },
  );

  await saveSyncManifest(
    context.syncManifestPath,
    createSyncManifest([...desiredManifestEntries, ...preservedEntries]),
  );

  runtime.logInfo(renderSyncReport(appliedItems, removedEntries, skippedItems));
}

/**
 * Derives the ownership key claimed by one sync target for conflict detection.
 */
function deriveOwnershipKeyForSyncTarget(
  syncItem: SyncItem,
  target: SyncTarget,
): OwnershipKey {
  return createOwnershipKey(parseSyncAgent(target.agent), syncItem.kind, {
    name: syncItem.name,
    outputPath: target.outputPath,
  });
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
 * Ensures that all target root directories exist before generated files are written.
 */
async function ensureTargetDirectories(
  targetRoots: TargetRoots,
): Promise<void> {
  await Promise.all(
    listTargetRootPaths(targetRoots).map((dir) => fs.ensureDir(dir)),
  );
}

type SyncManifestLoadResult = {
  manifest: SyncManifest;
  recoveryWarning?: string;
};

function isSyncItemKind(value: string): value is SyncItemKind {
  for (const allowed of SYNC_ITEM_KINDS) {
    if (allowed === value) {
      return true;
    }
  }
  return false;
}

/**
 * Parses `outputs` entries (best-effort) when the manifest file is not in the
 * usual shape (e.g. wrong `version`, missing required fields, invalid field
 * types, or malformed rows in `outputs`). Keep only rows with a recognized
 * agent, kind, and non-empty name/outputPath.
 */
function parseLenientSyncManifestOutputs(
  parsed: unknown,
): { entries: SyncManifestEntry[]; sourceRowCount: number } | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;

  if (!('outputs' in candidate)) {
    return null;
  }

  const rawOutputs = candidate.outputs;
  if (!Array.isArray(rawOutputs)) {
    return null;
  }

  const sourceRowCount = rawOutputs.length;
  const entries: SyncManifestEntry[] = [];

  for (const row of rawOutputs) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }

    const record = row as Record<string, unknown>;
    const agent = record.agent;
    const kind = record.kind;
    const name = record.name;
    const outputPath = record.outputPath;

    if (
      typeof agent !== 'string' ||
      typeof kind !== 'string' ||
      typeof name !== 'string' ||
      typeof outputPath !== 'string'
    ) {
      continue;
    }

    if (!isSyncAgent(agent)) {
      continue;
    }

    if (!isSyncItemKind(kind)) {
      continue;
    }

    if (name.length < 1 || outputPath.length < 1) {
      continue;
    }

    entries.push({
      agent,
      kind,
      name,
      outputPath,
    });
  }

  return { entries, sourceRowCount };
}

/**
 * Reads the sync manifest from disk, or returns an empty manifest if none
 * exists yet.
 *
 * Any failure to read, parse, or validate (including an older schema version)
 * falls back to an empty manifest when recovery is not possible. When the file
 * does not match the expected shape, this still tries to recover saved paths so
 * cleanup of removed items can run; if that fails, the prior manifest is empty
 * and a warning notes that leftover files may stay untracked until you remove
 * them manually.
 *
 * On the next sync after a fallback, current outputs are re-evaluated from
 * on-disk state, so existing matching outputs may still be reported as
 * `(unchanged)` rather than `(installed)`.
 */
async function loadSyncManifest(
  manifestPath: string,
): Promise<SyncManifestLoadResult> {
  if (!(await fs.pathExists(manifestPath))) {
    return { manifest: createSyncManifest([]) };
  }

  let rawManifest: string;
  try {
    rawManifest = await fs.readFile(manifestPath, 'utf8');
  } catch {
    return {
      manifest: createSyncManifest([]),
      recoveryWarning: `Could not read sync-manifest.json. Files left behind after you remove a command, rule, or skill may stay untracked and may need manual cleanup.`,
    };
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch {
    return {
      manifest: createSyncManifest([]),
      recoveryWarning: `sync-manifest.json is damaged or incomplete and could not be read. Files left behind after you remove something from your config may stay untracked and may need manual cleanup.`,
    };
  }

  const strictResult = syncManifestSchema.safeParse(parsedManifest);
  if (strictResult.success) {
    return { manifest: strictResult.data };
  }

  const lenient = parseLenientSyncManifestOutputs(parsedManifest);
  if (lenient !== null && lenient.entries.length > 0) {
    return {
      manifest: createSyncManifest(lenient.entries),
      recoveryWarning: `sync-manifest.json did not match the expected layout, but ${lenient.entries.length} saved path(s) were recovered. Cleanup of old outputs should still work. The file will be rewritten when sync finishes.`,
    };
  }

  if (lenient !== null && lenient.sourceRowCount === 0) {
    return { manifest: createSyncManifest([]) };
  }

  if (lenient !== null && lenient.entries.length === 0) {
    return {
      manifest: createSyncManifest([]),
      recoveryWarning: `sync-manifest.json lists paths, but none of them could be understood. Files left behind after you remove something from your config may stay untracked and may need manual cleanup.`,
    };
  }

  return {
    manifest: createSyncManifest([]),
    recoveryWarning: `sync-manifest.json could not be loaded. Files left behind after you remove something from your config may stay untracked and may need manual cleanup.`,
  };
}

/**
 * Serializes and writes the sync manifest to manifestPath.
 */
async function saveSyncManifest(
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
function createSyncManifest(entries: SyncManifestEntry[]): SyncManifest {
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
async function collectMarkdownFiles(rootDir: string): Promise<string[]> {
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
 * Computes a content hash for one sync target that identifies the bytes
 * that WOULD be written on the next sync. Markdown targets hash the exact
 * rendered output (frontmatter + body). Directory targets hash a sorted,
 * serialized snapshot of per-file SHA-256 hashes under the source
 * directory. The hash is stable across runs as long as the effective
 * content is unchanged, and is used to detect the `unchanged` branch.
 */
async function computeTargetContentHash(target: SyncTarget): Promise<string> {
  if (target.targetType === 'markdown') {
    const content = renderMarkdown({
      metadata: target.metadata,
      body: target.body,
    });
    return createHash('sha256').update(content).digest('hex');
  }

  const fileHashes = await computeDirectoryHashes(target.sourceDir);
  const serialized = JSON.stringify(
    Object.entries(fileHashes).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * SHA-256 of the bytes currently on disk for this target, using the same
 * serialization as {@link computeTargetContentHash} so it can be compared
 * to the would-be-written hash. Returns `undefined` if the artifact is
 * missing or cannot be read.
 */
async function computeOnDiskContentHash(
  target: SyncTarget,
): Promise<string | undefined> {
  if (target.targetType === 'markdown') {
    const filePath = target.writePath;
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
    if (!(await fs.pathExists(target.outputPath))) {
      return undefined;
    }
    const fileHashes = await computeDirectoryHashes(target.outputPath);
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
 * On-disk path that must exist for a target to be treated as already materialized.
 * Matches what `writeSyncTarget` creates: markdown targets use `writePath` (the file),
 * which can differ from manifest `outputPath` when that row names a parent directory
 * (e.g. Cursor commands). Directory targets use `outputPath` as the copy root.
 */
function getSyncTargetArtifactPath(target: SyncTarget): string {
  return target.targetType === 'markdown'
    ? target.writePath
    : target.outputPath;
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
  target: SyncTarget;
  desiredContentHash: string;
}): Promise<SyncAppliedChangeType> {
  const artifactExists = await fs.pathExists(
    getSyncTargetArtifactPath(input.target),
  );

  if (!artifactExists) {
    return 'installed';
  }

  const onDiskHash = await computeOnDiskContentHash(input.target);
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
async function applySyncItem(syncItem: SyncItem): Promise<AppliedSyncItem> {
  const directoryHashCache = new Map<string, Promise<string>>();

  const changes = await Promise.all(
    syncItem.targets.map(async (target): Promise<ItemSyncChange> => {
      let desiredContentHash: string;
      if (target.targetType === 'directory') {
        const cachedHashPromise = directoryHashCache.get(target.sourceDir);
        const contentHashPromise =
          cachedHashPromise ?? computeTargetContentHash(target);

        if (!cachedHashPromise) {
          directoryHashCache.set(target.sourceDir, contentHashPromise);
        }

        desiredContentHash = await contentHashPromise;
      } else {
        desiredContentHash = await computeTargetContentHash(target);
      }

      const changeType = await detectAppliedChangeType({
        target,
        desiredContentHash,
      });

      return {
        target,
        agent: parseSyncAgent(target.agent),
        changeType,
      };
    }),
  );

  for (const change of changes) {
    if (change.changeType === 'unchanged') {
      continue;
    }
    await writeSyncTarget(change.target);
  }

  return {
    item: syncItem,
    changes,
  };
}

/**
 * Writes one sync target to its output path, either as a markdown file or a directory copy.
 */
async function writeSyncTarget(target: SyncTarget): Promise<void> {
  if (target.targetType === 'markdown') {
    await writeMarkdownFile(target.writePath, target.metadata, target.body);
    return;
  }

  await copyDirectoryContents(target.sourceDir, target.outputPath);
}

/**
 * Collects sync operations for command sources after validating their frontmatter.
 */
async function collectCommandSyncItems(
  context: AgentsContext,
  runtime: CLIRuntime,
): Promise<SyncItem[]> {
  const { targetRoots } = context;
  const commandFiles = await collectMarkdownFiles(context.sourceRoots.commands);
  const syncItems: SyncItem[] = [];

  for (const filePath of commandFiles) {
    const fileName = path.basename(filePath, '.md');
    const rawContent = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseFrontmatter(rawContent);
    const commandMetadata = validateFrontmatter(runtime, {
      filePath,
      metadata,
      schema: commandFrontmatterSchema,
    });

    if (!commandMetadata) {
      continue;
    }

    const commandName = commandMetadata.name;
    const commandSpec = createAgentCmdSyncSpec(runtime, {
      filePath,
      sourceFileStem: fileName,
      body,
      frontmatter: commandMetadata,
    });

    if (!commandSpec) {
      continue;
    }

    syncItems.push({
      kind: 'command',
      name: commandName,
      sourcePath: filePath,
      targets: buildSyncTargets({
        kind: 'command',
        input: commandSpec.input,
        targetRoots,
        agents: commandSpec.activeAgents,
      }),
    });
  }

  return syncItems;
}

/**
 * Collects sync operations for rule sources after validating their frontmatter.
 */
async function collectRuleSyncItems(
  context: AgentsContext,
  runtime: CLIRuntime,
): Promise<SyncItem[]> {
  const { targetRoots } = context;
  const ruleFiles = await collectMarkdownFiles(context.sourceRoots.rules);
  const syncItems: SyncItem[] = [];

  for (const filePath of ruleFiles) {
    const fileName = path.basename(filePath, '.md');
    const rawContent = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseFrontmatter(rawContent);
    const ruleMetadata = validateFrontmatter(runtime, {
      filePath,
      metadata,
      schema: ruleFrontmatterSchema,
    });

    if (!ruleMetadata) {
      continue;
    }

    const ruleSpec = createAgentRuleSyncSpec(runtime, {
      filePath,
      sourceFileStem: fileName,
      body,
      frontmatter: ruleMetadata,
    });

    if (!ruleSpec) {
      continue;
    }

    syncItems.push({
      kind: 'rule',
      name: fileName,
      sourcePath: filePath,
      targets: buildSyncTargets({
        kind: 'rule',
        input: ruleSpec.input,
        targetRoots,
        agents: ruleSpec.activeAgents,
      }),
    });
  }

  return syncItems;
}

/**
 * Collects sync operations for local skill directories.
 */
async function collectSkillSyncItems(
  context: AgentsContext,
): Promise<SyncItem[]> {
  const { targetRoots } = context;
  await fs.ensureDir(context.sourceRoots.skills);
  const entries = await fs.readdir(context.sourceRoots.skills, {
    withFileTypes: true,
  });
  const syncItems: SyncItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceDir = path.join(context.sourceRoots.skills, entry.name);

    syncItems.push({
      kind: 'skill',
      name: entry.name,
      sourcePath: sourceDir,
      targets: buildSyncTargets({
        kind: 'skill',
        input: {
          name: entry.name,
          sourceDir,
        },
        targetRoots,
      }),
    });
  }

  return syncItems;
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
function collectConflictFilterResult(items: SyncItem[]): ConflictFilterResult {
  const ownershipMap = new Map<OwnershipKey, SyncItem[]>();

  for (const item of items) {
    for (const ownershipKey of collectOwnershipKeys(item)) {
      const existingOwners = ownershipMap.get(ownershipKey);

      if (existingOwners) {
        existingOwners.push(item);
      } else {
        ownershipMap.set(ownershipKey, [item]);
      }
    }
  }

  const skippedItemsBySourcePath = new Map<string, SkippedSyncItem>();

  for (const [ownershipKey, owners] of ownershipMap) {
    if (owners.length < 2) {
      continue;
    }

    const conflictDescription = describeOwnershipKey(ownershipKey);

    for (const owner of owners) {
      const existingSkippedItem = skippedItemsBySourcePath.get(
        owner.sourcePath,
      );

      if (existingSkippedItem) {
        existingSkippedItem.conflictDescriptions.push(conflictDescription);
      } else {
        skippedItemsBySourcePath.set(owner.sourcePath, {
          item: owner,
          conflictDescriptions: [conflictDescription],
        });
      }
    }
  }

  const skippedItems = [...skippedItemsBySourcePath.values()].map(
    (skippedItem) => ({
      item: skippedItem.item,
      conflictDescriptions: [
        ...new Set(skippedItem.conflictDescriptions),
      ].sort(),
    }),
  );
  const skippedSourcePaths = new Set(
    skippedItems.map((skippedItem) => skippedItem.item.sourcePath),
  );

  return {
    syncableItems: items.filter(
      (item) => !skippedSourcePaths.has(item.sourcePath),
    ),
    skippedItems,
  };
}

/**
 * Returns the ownership keys used to detect namespace conflicts for one sync item.
 */
function collectOwnershipKeys(syncItem: SyncItem): OwnershipKey[] {
  return syncItem.targets.map((target) =>
    deriveOwnershipKeyForSyncTarget(syncItem, target),
  );
}

/**
 * Returns the set of ownership keys whose items were skipped due to conflicts.
 */
function collectSkippedOwnershipKeys(
  skippedItems: SkippedSyncItem[],
): Set<OwnershipKey> {
  const ownershipKeys = skippedItems.flatMap((skippedItem) =>
    collectOwnershipKeys(skippedItem.item),
  );

  return new Set(ownershipKeys);
}

/**
 * Converts applied sync items into manifest entries for desired outputs.
 */
function collectManifestEntriesFromApplied(
  appliedItems: AppliedSyncItem[],
): SyncManifestEntry[] {
  return appliedItems.flatMap((appliedItem) =>
    appliedItem.changes.map((change) => ({
      agent: change.agent,
      kind: appliedItem.item.kind,
      name: appliedItem.item.name,
      outputPath: change.target.outputPath,
    })),
  );
}

/**
 * Returns the manifest entries that should be removed because they are no longer desired.
 */
function collectRemovedManifestEntries(
  manifestEntries: SyncManifestEntry[],
  input: {
    desiredOutputPaths: ReadonlySet<string>;
    skippedOwnershipKeys: ReadonlySet<OwnershipKey>;
  },
): SyncManifestEntry[] {
  return manifestEntries.filter(
    (entry) =>
      !input.desiredOutputPaths.has(entry.outputPath) &&
      !input.skippedOwnershipKeys.has(
        deriveOwnershipKeyForManifestEntry(entry),
      ),
  );
}

/**
 * Returns manifest entries for skipped source items due to a conflict.
 */
function collectPreservedManifestEntries(
  manifestEntries: SyncManifestEntry[],
  input: {
    desiredOutputPaths: ReadonlySet<string>;
    skippedOwnershipKeys: ReadonlySet<OwnershipKey>;
  },
): SyncManifestEntry[] {
  return manifestEntries.filter(
    (entry) =>
      !input.desiredOutputPaths.has(entry.outputPath) &&
      input.skippedOwnershipKeys.has(deriveOwnershipKeyForManifestEntry(entry)),
  );
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
function renderSyncReport(
  appliedItems: AppliedSyncItem[],
  removedEntries: SyncManifestEntry[],
  skippedItems: SkippedSyncItem[],
): string {
  const agentSections = SYNC_AGENTS.map((agent) =>
    renderAgentSyncSection(
      getAgentLabel(agent),
      collectAgentReportedSyncChanges(appliedItems, removedEntries, agent),
    ),
  ).filter((section): section is string => section !== undefined);

  const sections =
    agentSections.length === 0
      ? [`${chalk.bold.cyan('Applied changes:')} ${chalk.green('None')}`]
      : [chalk.bold.cyan('Applied changes:'), ...agentSections];

  if (skippedItems.length === 0) {
    sections.push(
      `${chalk.bold.green('Skipped conflicts:')} ${chalk.green('None')}`,
    );
  } else {
    const skippedLines = skippedItems
      .slice()
      .sort((left, right) =>
        formatSyncItemLabel(left.item).localeCompare(
          formatSyncItemLabel(right.item),
        ),
      )
      .map((skippedItem) =>
        [
          `- ${chalk.red(formatSyncItemLabel(skippedItem.item))}`,
          `  * ${chalk.bold.red('due to:')} ${chalk.yellow(skippedItem.conflictDescriptions.join(', '))}`,
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
  appliedItems: AppliedSyncItem[],
  removedEntries: SyncManifestEntry[],
  agent: SyncAgent,
): ReportedAgentSyncChange[] {
  const appliedChanges = appliedItems.flatMap((appliedItem) =>
    appliedItem.changes
      .filter(
        (change) => change.agent === agent && change.changeType !== 'unchanged',
      )
      .map((change) => ({
        kind: appliedItem.item.kind,
        name: appliedItem.item.name,
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
 * Returns a readable label for one sync item in conflict warnings.
 */
function formatSyncItemLabel(item: SyncItem): string {
  return `${item.kind} "${item.name}" from ${item.sourcePath}`;
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
