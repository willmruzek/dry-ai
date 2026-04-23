import path from 'node:path';

import type { CLIRuntime } from '../cli.js';

import { AGENT_DEFINITIONS } from './agent-definitions.js';
import {
  type SyncTargetSpec,
  type AgentCmdSyncSpec,
  type OwnershipKeyInput,
  type AgentRuleSyncSpec,
  type SyncItemKind,
} from './agent-types.js';
import type { CommandFrontmatter, RuleFrontmatter } from './frontmatter.js';

export { AGENT_DEFINITIONS } from './agent-definitions.js';
export {
  SYNC_ITEM_KINDS,
  type SyncTargetSpec as BuildSyncTargetsInput,
  type AgentCmdSyncSpec as CommandSyncSource,
  type OwnershipKeyInput,
  type AgentRuleSyncSpec as RuleSyncSource,
  type AgentSkillSyncSpec as SkillSyncSource,
  type SyncItemKind,
  type AgentSyncSpecByKind as SyncSourceByKind,
} from './agent-types.js';

export type SyncAgent = keyof typeof AGENT_DEFINITIONS;
export type TargetRoots = Record<string, Record<string, string>>;

/**
 * Returns whether a string is a recognized sync agent name.
 */
export function isSyncAgent(value: string): value is SyncAgent {
  return Object.hasOwn(AGENT_DEFINITIONS, value);
}

/**
 * Returns all sync agent names from the registry, in definition order.
 */
function collectSyncAgents(): SyncAgent[] {
  const agents: SyncAgent[] = [];

  for (const value in AGENT_DEFINITIONS) {
    if (isSyncAgent(value)) {
      agents.push(value);
    }
  }

  return agents;
}

export const SYNC_AGENTS = collectSyncAgents();

export type OwnershipKey = string;

export type SyncTarget =
  | {
      agent: string;
      outputPath: string;
      targetType: 'markdown';
      body: string;
      metadata: Record<string, unknown>;
      writePath: string;
    }
  | {
      agent: string;
      outputPath: string;
      targetType: 'directory';
      sourceDir: string;
    };

export type MarkdownSyncTarget = Extract<
  SyncTarget,
  {
    targetType: 'markdown';
  }
>;

export type DirectorySyncTarget = Extract<
  SyncTarget,
  {
    targetType: 'directory';
  }
>;

export type SyncMarkdownMetadata = MarkdownSyncTarget['metadata'];

/**
 * Returns the definition for the given sync agent from the central registry.
 */
function getAgentDefinition(agent: SyncAgent) {
  return AGENT_DEFINITIONS[agent];
}

/**
 * Returns the command source definition for the given agent.
 */
function getCommandSourceDefinition(agent: SyncAgent) {
  return getAgentDefinition(agent).command.frontmatterSection;
}

/**
 * Returns the rule source definition for the given agent.
 */
function getRuleSourceDefinition(agent: SyncAgent) {
  return getAgentDefinition(agent).rule.frontmatterSection;
}

/**
 * Returns all ownership definitions registered across every agent and item kind.
 */
function listOwnershipDefinitions() {
  return SYNC_AGENTS.flatMap((agent) => {
    const definition = getAgentDefinition(agent);

    return [
      definition.command.ownershipKey,
      definition.rule.ownershipKey,
      definition.skill.ownershipKey,
    ];
  });
}

/**
 * Builds the map of output root directory paths for every agent, each resolved relative to baseDir.
 */
export function createTargetRoots(baseDir: string): TargetRoots {
  return Object.fromEntries(
    SYNC_AGENTS.map((agent) => {
      const segmentRoots = getAgentDefinition(agent).targetRoots as Record<
        string,
        readonly string[]
      >;

      return [
        agent,
        Object.fromEntries(
          Object.entries(segmentRoots).map(([rootName, pathSegments]) => [
            rootName,
            path.join(baseDir, ...pathSegments),
          ]),
        ),
      ];
    }),
  );
}

/**
 * Returns the display label used for one agent in user-facing sync reports.
 */
export function getAgentLabel(agent: SyncAgent): string {
  return getAgentDefinition(agent).displayLabel;
}

/**
 * Returns the supported agent names joined as a natural English list.
 */
export function describeSupportedAgents(): string {
  return formatLabelList(SYNC_AGENTS.map(getAgentLabel));
}

/**
 * Returns every output root directory path from the given TargetRoots map.
 */
export function listTargetRootPaths(targetRoots: TargetRoots): string[] {
  return SYNC_AGENTS.flatMap((agent) => Object.values(targetRoots[agent]));
}

/**
 * Builds one sync target per supported agent for the given item kind and input.
 */
function resolveAgentsForSync(
  value: Extract<SyncTargetSpec, { kind: 'command' } | { kind: 'rule' }>,
): SyncAgent[] {
  if (value.agents) {
    return SYNC_AGENTS.filter((agent) => value.agents!.includes(agent));
  }

  return [...SYNC_AGENTS];
}

export function buildSyncTargets(value: SyncTargetSpec): SyncTarget[] {
  switch (value.kind) {
    case 'command': {
      const agents = resolveAgentsForSync(value);

      return agents.map((agent) =>
        getAgentDefinition(agent).command.target.buildTarget({
          input: value.input,
          targetRoots: value.targetRoots,
        }),
      );
    }
    case 'rule': {
      const agents = resolveAgentsForSync(value);

      return agents.map((agent) =>
        getAgentDefinition(agent).rule.target.buildTarget({
          input: value.input,
          targetRoots: value.targetRoots,
        }),
      );
    }
    case 'skill': {
      return SYNC_AGENTS.map((agent) =>
        getAgentDefinition(agent).skill.target.buildTarget({
          input: value.input,
          targetRoots: value.targetRoots,
        }),
      );
    }
  }
}

/**
 * Returns the ownership key for the given agent, item kind, and input.
 */
export function createOwnershipKey(
  agent: SyncAgent,
  kind: SyncItemKind,
  value: OwnershipKeyInput,
): OwnershipKey {
  switch (kind) {
    case 'command': {
      return getAgentDefinition(agent).command.ownershipKey.createKeyForInput(
        value,
      );
    }
    case 'rule': {
      return getAgentDefinition(agent).rule.ownershipKey.createKeyForInput(
        value,
      );
    }
    case 'skill': {
      return getAgentDefinition(agent).skill.ownershipKey.createKeyForInput(
        value,
      );
    }
  }
}

/**
 * Returns whether an ownership key starts with the given prefix.
 */
function hasOwnershipKeyPrefix(ownershipKey: string, prefix: string): boolean {
  return ownershipKey.startsWith(prefix);
}

/**
 * Strips the given prefix from an ownership key and returns the remainder.
 */
function stripOwnershipKeyPrefix(ownershipKey: string, prefix: string): string {
  return ownershipKey.slice(prefix.length);
}

/**
 * Formats an ownership key as a human-readable phrase for use in warning messages.
 */
export function describeOwnershipKey(ownershipKey: OwnershipKey): string {
  for (const definition of listOwnershipDefinitions()) {
    if (hasOwnershipKeyPrefix(ownershipKey, definition.prefix)) {
      return `${definition.descriptionLabel} "${stripOwnershipKeyPrefix(ownershipKey, definition.prefix)}"`;
    }
  }

  return `output namespace "${ownershipKey}"`;
}

/**
 * Formats a list of strings as a natural English enumeration (e.g. "a, b, and c").
 */
function formatLabelList(values: string[]): string {
  if (values.length === 0) {
    return '';
  }

  if (values.length === 1) {
    return values[0];
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

/**
 * Serializes validation errors as dot-qualified field paths paired with messages, joined by semicolons.
 */
function formatValidationIssues(input: {
  issues: readonly { message: string; path: readonly PropertyKey[] }[];
  pathPrefix: string;
}): string {
  return input.issues
    .map((issue) => {
      const fieldPath =
        issue.path.length > 0
          ? `${input.pathPrefix}.${issue.path.join('.')}`
          : input.pathPrefix;

      return `${fieldPath}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Reads the per-agent blocks from parsed frontmatter and returns a map of agent → raw section value.
 */
function collectAgentSectionValues<K extends 'command' | 'rule'>(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    kind: K;
    sections: K extends 'command'
      ? CommandFrontmatter['agents']
      : RuleFrontmatter['agents'];
  },
): Map<SyncAgent, unknown> | null {
  const sectionValues = new Map<SyncAgent, unknown>();

  if (!input.sections) {
    return sectionValues;
  }

  const unknownAgents: string[] = [];

  for (const [agent, value] of Object.entries(input.sections)) {
    if (isSyncAgent(agent)) {
      sectionValues.set(agent, value);
      continue;
    }

    unknownAgents.push(agent);
  }

  if (unknownAgents.length > 0) {
    runtime.logInfo(
      `Skipping invalid ${input.kind} frontmatter in ${input.filePath}: ${unknownAgents
        .map((agent) => `agents.${agent}: Unsupported agent`)
        .join('; ')}`,
    );
    return null;
  }

  return sectionValues;
}

/**
 * Validates each per-agent command block and merges successful sections into
 * the base sync input. Invalid sections log a warning and that agent is
 * skipped; if no agent is valid, returns null.
 */
function extendCommandSyncInputFromAgentSections(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    currentInput: AgentCmdSyncSpec;
    sections: CommandFrontmatter['agents'];
  },
): { currentInput: AgentCmdSyncSpec; activeAgents: SyncAgent[] } | null {
  const sectionValues = collectAgentSectionValues(runtime, {
    filePath: input.filePath,
    kind: 'command',
    sections: input.sections,
  });

  if (!sectionValues) {
    return null;
  }

  let currentInput = input.currentInput;
  const activeAgents: SyncAgent[] = [];

  for (const agent of SYNC_AGENTS) {
    const sourceDefinition = getCommandSourceDefinition(agent);
    const result = sourceDefinition.createSyncInputExtension(
      sectionValues.get(agent),
      {
        currentInput,
        sectionValues,
      },
    );

    if (!result.success) {
      runtime.logWarn(
        `Skipping ${getAgentLabel(agent)} for ${input.filePath}: ${formatValidationIssues(
          {
            issues: result.issues,
            pathPrefix: `agents.${agent}`,
          },
        )}`,
      );
      continue;
    }

    currentInput = {
      ...currentInput,
      ...result.data,
    };
    activeAgents.push(agent);
  }

  if (activeAgents.length === 0) {
    return null;
  }

  return { currentInput, activeAgents };
}

/**
 * Validates each per-agent rule block and merges successful sections into the
 * base sync input. Invalid sections log a warning and that agent is skipped;
 * if no agent is valid, returns null.
 */
function extendRuleSyncInputFromAgentSections(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    currentInput: AgentRuleSyncSpec;
    sections: RuleFrontmatter['agents'];
  },
): { currentInput: AgentRuleSyncSpec; activeAgents: SyncAgent[] } | null {
  const sectionValues = collectAgentSectionValues(runtime, {
    filePath: input.filePath,
    kind: 'rule',
    sections: input.sections,
  });

  if (!sectionValues) {
    return null;
  }

  let currentInput = input.currentInput;
  const activeAgents: SyncAgent[] = [];

  for (const agent of SYNC_AGENTS) {
    const sourceDefinition = getRuleSourceDefinition(agent);
    const result = sourceDefinition.createSyncInputExtension(
      sectionValues.get(agent),
      {
        currentInput,
        sectionValues,
      },
    );

    if (!result.success) {
      runtime.logWarn(
        `Skipping ${getAgentLabel(agent)} for ${input.filePath}: ${formatValidationIssues(
          {
            issues: result.issues,
            pathPrefix: `agents.${agent}`,
          },
        )}`,
      );
      continue;
    }

    currentInput = {
      ...currentInput,
      ...result.data,
    };
    activeAgents.push(agent);
  }

  if (activeAgents.length === 0) {
    return null;
  }

  return { currentInput, activeAgents };
}

/**
 * Builds a command sync spec from per-agent `agents` blocks. Omits agents
 * whose sections fail validation (with a warning); returns null if none are valid.
 */
export function createAgentCmdSyncSpec(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    sourceFileStem: string;
    body: string;
    frontmatter: CommandFrontmatter;
  },
): {
  input: AgentCmdSyncSpec;
  activeAgents: SyncAgent[];
} | null {
  const result = extendCommandSyncInputFromAgentSections(runtime, {
    filePath: input.filePath,
    currentInput: {
      name: input.frontmatter.name,
      description: input.frontmatter.description,
      sourceFileStem: input.sourceFileStem,
      body: input.body,
      disableModelInvocation: undefined,
    },
    sections: input.frontmatter.agents,
  });

  if (!result) {
    return null;
  }

  return { input: result.currentInput, activeAgents: result.activeAgents };
}

/**
 * Builds a rule sync spec from per-agent `agents` blocks. Omits agents
 * whose sections fail validation (with a warning); returns null if none are valid.
 */
export function createAgentRuleSyncSpec(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    sourceFileStem: string;
    body: string;
    frontmatter: RuleFrontmatter;
  },
): {
  input: AgentRuleSyncSpec;
  activeAgents: SyncAgent[];
} | null {
  const result = extendRuleSyncInputFromAgentSections(runtime, {
    filePath: input.filePath,
    currentInput: {
      name: input.sourceFileStem,
      description: input.frontmatter.description,
      sourceFileStem: input.sourceFileStem,
      body: input.body,
      applyTo: '',
      globs: undefined,
      alwaysApply: false,
    },
    sections: input.frontmatter.agents,
  });

  if (!result) {
    return null;
  }

  return { input: result.currentInput, activeAgents: result.activeAgents };
}
