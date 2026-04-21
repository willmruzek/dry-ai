import { Chalk } from 'chalk';
import fs from 'fs-extra';
import { glob } from 'glob';
import path from 'node:path';
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

type SyncAppliedChangeType = 'installed' | 'updated';
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
  version: z.literal(2),
  outputs: z.array(syncManifestEntrySchema),
});

type SyncItem = {
  kind: SyncItemKind;
  name: string;
  sourcePath: string;
  targets: readonly SyncTarget[];
};

type ItemSyncChange = {
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

  const previousManifest = await loadSyncManifest(context.syncManifestPath);
  const syncItems = [
    ...(await collectCommandSyncItems(context, runtime)),
    ...(await collectRuleSyncItems(context, runtime)),
    ...(await collectSkillSyncItems(context)),
  ];
  const { syncableItems, skippedItems } =
    collectConflictFilterResult(syncItems);
  const skippedOwnershipKeys = collectSkippedOwnershipKeys(skippedItems);
  const desiredManifestEntries = collectManifestEntries(syncableItems);
  const desiredOutputPaths = new Set(
    desiredManifestEntries.map((entry) => entry.outputPath),
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
  await Promise.all(listTargetRootPaths(targetRoots).map(fs.ensureDir));
}

/**
 * Reads the sync manifest from disk, or returns an empty manifest if none exists yet.
 */
async function loadSyncManifest(manifestPath: string): Promise<SyncManifest> {
  if (!(await fs.pathExists(manifestPath))) {
    return createSyncManifest([]);
  }

  const rawManifest = await fs.readFile(manifestPath, 'utf8');
  const parsedManifest: unknown = JSON.parse(rawManifest);

  return syncManifestSchema.parse(parsedManifest);
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
    version: 2,
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
 * Detects whether each agent target for one item will be installed or updated.
 */
async function detectSyncChanges(
  syncItem: SyncItem,
): Promise<ItemSyncChange[]> {
  return Promise.all(
    syncItem.targets.map(async (target) => ({
      agent: parseSyncAgent(target.agent),
      changeType: (await fs.pathExists(target.outputPath))
        ? 'updated'
        : 'installed',
    })),
  );
}

/**
 * Applies one sync item and records the change type for each agent target.
 */
async function applySyncItem(syncItem: SyncItem): Promise<AppliedSyncItem> {
  const changes = await detectSyncChanges(syncItem);
  await writeSyncItem(syncItem);

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
 * Writes one sync item to all of its target outputs.
 */
async function writeSyncItem(syncItem: SyncItem): Promise<void> {
  for (const target of syncItem.targets) {
    await writeSyncTarget(target);
  }
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
    const commandInput = createAgentCmdSyncSpec(runtime, {
      filePath,
      sourceFileStem: fileName,
      body,
      frontmatter: commandMetadata,
    });

    if (!commandInput) {
      continue;
    }

    syncItems.push({
      kind: 'command',
      name: commandName,
      sourcePath: filePath,
      targets: buildSyncTargets({
        kind: 'command',
        input: commandInput,
        targetRoots,
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

    const ruleInput = createAgentRuleSyncSpec(runtime, {
      filePath,
      sourceFileStem: fileName,
      body,
      frontmatter: ruleMetadata,
    });

    if (!ruleInput) {
      continue;
    }

    syncItems.push({
      kind: 'rule',
      name: fileName,
      sourcePath: filePath,
      targets: buildSyncTargets({
        kind: 'rule',
        input: ruleInput,
        targetRoots,
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
 * Converts sync items into manifest entries for the current desired outputs.
 */
function collectManifestEntries(syncItems: SyncItem[]): SyncManifestEntry[] {
  return syncItems.flatMap((syncItem) =>
    syncItem.targets.map((target) => ({
      agent: parseSyncAgent(target.agent),
      kind: syncItem.kind,
      name: syncItem.name,
      outputPath: target.outputPath,
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
  const sections = [chalk.bold.cyan('Applied changes:')];

  for (const agent of SYNC_AGENTS) {
    sections.push(
      renderAgentSyncSection(
        getAgentLabel(agent),
        collectAgentReportedSyncChanges(appliedItems, removedEntries, agent),
      ),
    );
  }

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
      .filter((change) => change.agent === agent)
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
 */
function renderAgentSyncSection(
  agentLabel: string,
  reportedChanges: ReportedAgentSyncChange[],
): string {
  const kindSections = [
    renderKindSyncLine('commands', 'command', reportedChanges),
    renderKindSyncLine('rules', 'rule', reportedChanges),
    renderKindSyncLine('skills', 'skill', reportedChanges),
  ].filter((section) => section !== undefined);

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
