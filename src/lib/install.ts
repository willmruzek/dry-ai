import { Chalk } from 'chalk';
import fs from 'fs-extra';
import { glob } from 'glob';
import path from 'node:path';
import type { AgentsContext, TargetRoots } from './context.js';
import {
  commandFrontmatterSchema,
  compactObject,
  normalizeRuleMetadata,
  parseFrontmatter,
  renderMarkdown,
  ruleFrontmatterSchema,
  validateFrontmatter,
} from './frontmatter.js';

type InstallItemKind = 'command' | 'rule' | 'skill';

type InstallEditor = 'copilot' | 'cursor';

type InstallChangeType = 'install' | 'update';

const ALL_INSTALL_EDITORS: readonly InstallEditor[] = ['copilot', 'cursor'];
const chalk = new Chalk({ level: 3 });

type InstallTarget = {
  editor: InstallEditor;
  outputPath: string;
};

type InstallItem = {
  kind: InstallItemKind;
  editors: readonly InstallEditor[];
  name: string;
  sourcePath: string;
  ownershipKeys: string[];
  targets: readonly InstallTarget[];
  install: () => Promise<void>;
};

type ItemInstallChange = {
  editor: InstallEditor;
  changeType: InstallChangeType;
};

type AppliedInstallItem = {
  item: InstallItem;
  changes: ItemInstallChange[];
};

type EditorAppliedInstallItem = {
  item: InstallItem;
  changeType: InstallChangeType;
};

type SkippedInstallItem = {
  item: InstallItem;
  conflictDescriptions: string[];
};

type ConflictFilterResult = {
  installableItems: InstallItem[];
  skippedItems: SkippedInstallItem[];
};

/**
 * Installs all generated command, rule, and skill outputs into the requested targets.
 */
export async function installToTargets(
  context: AgentsContext,
  { targetRoots }: { targetRoots: TargetRoots },
): Promise<void> {
  await ensureTargetDirectories(targetRoots);

  const installItems = [
    ...(await collectCommandInstallItems(context, { targetRoots })),
    ...(await collectRuleInstallItems(context, { targetRoots })),
    ...(await collectSkillInstallItems(context, { targetRoots })),
  ];
  const { installableItems, skippedItems } =
    collectConflictFilterResult(installItems);

  const appliedItems: AppliedInstallItem[] = [];

  for (const installItem of installableItems) {
    appliedItems.push(await applyInstallItem(installItem));
  }

  console.log(renderInstallReport(appliedItems, skippedItems));
}

/**
 * Ensures that all target root directories exist before generated files are written.
 */
async function ensureTargetDirectories(
  targetRoots: TargetRoots,
): Promise<void> {
  await Promise.all(
    Object.values(targetRoots).map((dirPath) => fs.ensureDir(dirPath)),
  );
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
async function writeMarkdownFile(
  filePath: string,
  metadata: Record<string, unknown>,
  body: string,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, renderMarkdown({ metadata, body }), 'utf8');
}

/**
 * Detects whether each editor target for one item will be installed or updated.
 */
async function detectInstallChanges(
  installItem: InstallItem,
): Promise<ItemInstallChange[]> {
  return Promise.all(
    installItem.targets.map(async (target) => ({
      editor: target.editor,
      changeType: (await fs.pathExists(target.outputPath))
        ? 'update'
        : 'install',
    })),
  );
}

/**
 * Applies one install item and records the change type for each editor target.
 */
async function applyInstallItem(
  installItem: InstallItem,
): Promise<AppliedInstallItem> {
  const changes = await detectInstallChanges(installItem);
  await installItem.install();

  return {
    item: installItem,
    changes,
  };
}

/**
 * Collects install operations for command sources after validating their frontmatter.
 */
async function collectCommandInstallItems(
  context: AgentsContext,
  { targetRoots }: { targetRoots: TargetRoots },
): Promise<InstallItem[]> {
  const commandFiles = await collectMarkdownFiles(context.sourceRoots.commands);
  const installItems: InstallItem[] = [];

  for (const filePath of commandFiles) {
    const fileName = path.basename(filePath, '.md');
    const rawContent = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseFrontmatter(rawContent);
    const commandMetadata = validateFrontmatter({
      filePath,
      metadata,
      schema: commandFrontmatterSchema,
    });

    if (!commandMetadata) {
      continue;
    }

    const commandName = commandMetadata.name;
    const description = commandMetadata.description;
    const copilotPromptPath = path.join(
      targetRoots.copilotPrompts,
      `${fileName}.prompt.md`,
    );
    const cursorSkillPath = path.join(
      targetRoots.cursorSkills,
      commandName,
      'SKILL.md',
    );
    const promptMetadata = compactObject({
      name: commandName,
      description,
    });
    const cursorMetadata = compactObject({
      name: commandName,
      description,
      'disable-model-invocation':
        commandMetadata.cursor?.['disable-model-invocation'],
    });

    installItems.push({
      kind: 'command',
      editors: ALL_INSTALL_EDITORS,
      name: commandName,
      sourcePath: filePath,
      ownershipKeys: [
        `copilot-prompt-path:${copilotPromptPath}`,
        `cursor-skill-name:${commandName}`,
      ],
      targets: [
        { editor: 'copilot', outputPath: copilotPromptPath },
        { editor: 'cursor', outputPath: cursorSkillPath },
      ],
      install: async () => {
        await writeMarkdownFile(copilotPromptPath, promptMetadata, body);
        await writeMarkdownFile(cursorSkillPath, cursorMetadata, body);
      },
    });
  }

  return installItems;
}

/**
 * Collects install operations for rule sources after validating their frontmatter.
 */
async function collectRuleInstallItems(
  context: AgentsContext,
  { targetRoots }: { targetRoots: TargetRoots },
): Promise<InstallItem[]> {
  const ruleFiles = await collectMarkdownFiles(context.sourceRoots.rules);
  const installItems: InstallItem[] = [];

  for (const filePath of ruleFiles) {
    const fileName = path.basename(filePath, '.md');
    const rawContent = await fs.readFile(filePath, 'utf8');
    const { metadata, body } = parseFrontmatter(rawContent);
    const ruleMetadata = validateFrontmatter({
      filePath,
      metadata,
      schema: ruleFrontmatterSchema,
    });

    if (!ruleMetadata) {
      continue;
    }

    const normalized = normalizeRuleMetadata(ruleMetadata);
    const copilotInstructionPath = path.join(
      targetRoots.copilotInstructions,
      `${fileName}.instructions.md`,
    );
    const cursorRulePath = path.join(
      targetRoots.cursorRules,
      `${fileName}.mdc`,
    );

    const copilotMetadata = compactObject({
      description: ruleMetadata.description,
      applyTo: normalized.applyTo,
    });
    const cursorMetadata = compactObject({
      description: ruleMetadata.description,
      globs: normalized.alwaysApply ? undefined : normalized.globs,
      alwaysApply: normalized.alwaysApply,
    });

    installItems.push({
      kind: 'rule',
      editors: ALL_INSTALL_EDITORS,
      name: fileName,
      sourcePath: filePath,
      ownershipKeys: [
        `copilot-instruction-path:${copilotInstructionPath}`,
        `cursor-rule-path:${cursorRulePath}`,
      ],
      targets: [
        { editor: 'copilot', outputPath: copilotInstructionPath },
        { editor: 'cursor', outputPath: cursorRulePath },
      ],
      install: async () => {
        await writeMarkdownFile(copilotInstructionPath, copilotMetadata, body);
        await writeMarkdownFile(cursorRulePath, cursorMetadata, body);
      },
    });
  }

  return installItems;
}

/**
 * Collects install operations for local skill directories.
 */
async function collectSkillInstallItems(
  context: AgentsContext,
  { targetRoots }: { targetRoots: TargetRoots },
): Promise<InstallItem[]> {
  await fs.ensureDir(context.sourceRoots.skills);
  const entries = await fs.readdir(context.sourceRoots.skills, {
    withFileTypes: true,
  });
  const installItems: InstallItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceDir = path.join(context.sourceRoots.skills, entry.name);
    const copilotSkillPath = path.join(targetRoots.copilotSkills, entry.name);
    const cursorSkillPath = path.join(targetRoots.cursorSkills, entry.name);

    installItems.push({
      kind: 'skill',
      editors: ALL_INSTALL_EDITORS,
      name: entry.name,
      sourcePath: sourceDir,
      ownershipKeys: [
        `copilot-skill-name:${entry.name}`,
        `cursor-skill-name:${entry.name}`,
      ],
      targets: [
        { editor: 'copilot', outputPath: copilotSkillPath },
        { editor: 'cursor', outputPath: cursorSkillPath },
      ],
      install: async () => {
        await copyDirectoryContents(sourceDir, copilotSkillPath);
        await copyDirectoryContents(sourceDir, cursorSkillPath);
      },
    });
  }

  return installItems;
}

/**
 * Copies a skill directory into a target directory after clearing any previous contents.
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
 * Collects the installable and skipped items after analyzing output namespace conflicts.
 */
function collectConflictFilterResult(
  items: InstallItem[],
): ConflictFilterResult {
  const ownershipMap = new Map<string, InstallItem[]>();

  for (const item of items) {
    for (const ownershipKey of item.ownershipKeys) {
      const existingOwners = ownershipMap.get(ownershipKey);

      if (existingOwners) {
        existingOwners.push(item);
      } else {
        ownershipMap.set(ownershipKey, [item]);
      }
    }
  }

  const skippedItemsBySourcePath = new Map<string, SkippedInstallItem>();

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
    installableItems: items.filter(
      (item) => !skippedSourcePaths.has(item.sourcePath),
    ),
    skippedItems,
  };
}

/**
 * Renders an install summary grouped by editor, item kind, and skipped conflicts.
 */
function renderInstallReport(
  appliedItems: AppliedInstallItem[],
  skippedItems: SkippedInstallItem[],
): string {
  const sections = [chalk.bold.cyan('Applied changes:')];
  const copilotInstalledItems = collectEditorAppliedInstallItems(
    appliedItems,
    'copilot',
  );
  const cursorInstalledItems = collectEditorAppliedInstallItems(
    appliedItems,
    'cursor',
  );

  sections.push(renderEditorInstallSection('Copilot', copilotInstalledItems));
  sections.push(renderEditorInstallSection('Cursor', cursorInstalledItems));

  if (skippedItems.length === 0) {
    sections.push(
      `${chalk.bold.green('Skipped conflicts:')} ${chalk.green('None')}`,
    );
  } else {
    const skippedLines = skippedItems
      .slice()
      .sort((left, right) =>
        formatInstallItemLabel(left.item).localeCompare(
          formatInstallItemLabel(right.item),
        ),
      )
      .map((skippedItem) =>
        [
          `- ${chalk.red(formatInstallItemLabel(skippedItem.item))}`,
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
 * Collects the applied install items relevant to one editor.
 */
function collectEditorAppliedInstallItems(
  appliedItems: AppliedInstallItem[],
  editor: InstallEditor,
): EditorAppliedInstallItem[] {
  return appliedItems.flatMap((appliedItem) =>
    appliedItem.changes
      .filter((change) => change.editor === editor)
      .map((change) => ({
        item: appliedItem.item,
        changeType: change.changeType,
      })),
  );
}

/**
 * Renders the installed items for one editor grouped by item kind.
 */
function renderEditorInstallSection(
  editorLabel: string,
  installedItems: EditorAppliedInstallItem[],
): string {
  const kindSections = [
    renderKindInstallLine('commands', 'command', installedItems),
    renderKindInstallLine('rules', 'rule', installedItems),
    renderKindInstallLine('skills', 'skill', installedItems),
  ].filter((section) => section !== undefined);

  return [`- ${colorEditorLabel(editorLabel)}`, ...kindSections].join('\n');
}

/**
 * Renders one install summary section for a specific item kind.
 */
function renderKindInstallLine(
  label: string,
  kind: InstallItemKind,
  installedItems: EditorAppliedInstallItem[],
): string | undefined {
  const matchingItems = installedItems
    .filter((item) => item.item.kind === kind)
    .slice()
    .sort((left, right) => left.item.name.localeCompare(right.item.name));

  if (matchingItems.length === 0) {
    return undefined;
  }

  return [
    `  * ${colorKindLabel(label)}`,
    ...matchingItems.map(renderAppliedInstallItemLine),
  ].join('\n');
}

/**
 * Returns the styled editor label used in the install summary.
 */
function colorEditorLabel(editorLabel: string): string {
  return chalk.bold.blue(editorLabel);
}

/**
 * Returns the styled item-kind label used in the install summary.
 */
function colorKindLabel(label: string): string {
  return chalk.bold.yellow(label);
}

/**
 * Returns the styled change-type label used in the install summary.
 */
function colorChangeType(changeType: InstallChangeType): string {
  if (changeType === 'install') {
    return chalk.green(changeType);
  }

  return chalk.yellow(changeType);
}

/**
 * Renders one styled applied-item line in the install summary.
 */
function renderAppliedInstallItemLine(
  matchingItem: EditorAppliedInstallItem,
): string {
  return `    - ${chalk.whiteBright(matchingItem.item.name)} (${colorChangeType(matchingItem.changeType)})`;
}

/**
 * Returns a readable label for one install item in conflict warnings.
 */
function formatInstallItemLabel(item: InstallItem): string {
  return `${item.kind} "${item.name}" from ${item.sourcePath}`;
}

/**
 * Converts an internal ownership key into a warning message fragment.
 */
function describeOwnershipKey(ownershipKey: string): string {
  if (ownershipKey.startsWith('cursor-skill-name:')) {
    return `Cursor skill name "${ownershipKey.slice('cursor-skill-name:'.length)}"`;
  }

  if (ownershipKey.startsWith('copilot-skill-name:')) {
    return `Copilot skill name "${ownershipKey.slice('copilot-skill-name:'.length)}"`;
  }

  if (ownershipKey.startsWith('copilot-prompt-path:')) {
    return `Copilot prompt output "${ownershipKey.slice('copilot-prompt-path:'.length)}"`;
  }

  if (ownershipKey.startsWith('copilot-instruction-path:')) {
    return `Copilot instruction output "${ownershipKey.slice('copilot-instruction-path:'.length)}"`;
  }

  if (ownershipKey.startsWith('cursor-rule-path:')) {
    return `Cursor rule output "${ownershipKey.slice('cursor-rule-path:'.length)}"`;
  }

  return `output namespace "${ownershipKey}"`;
}
