import path from 'node:path';

import type { CLIRuntime } from '../cli.js';

import { AGENT_DEFINITIONS } from './agent-definitions.js';
import {
  type OwnershipKeyInput,
  type AgentRuleSource,
  type SyncItemKind,
} from './agent-types.js';
import type { CommandFrontmatter, RuleFrontmatter } from './frontmatter.js';

export { AGENT_DEFINITIONS } from './agent-definitions.js';
export {
  SYNC_ITEM_KINDS,
  type AgentCmdSource as CommandSyncSource,
  type OwnershipKeyInput,
  type AgentRuleSource as RuleSyncSource,
  type AgentSkillSource as SkillSyncSource,
  type SyncItemKind,
  type AgentSourceByKind as SyncSourceByKind,
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

export type ArtifactSpec =
  | {
      /** Agent that owns this generated artifact. */
      agent: string;
      /** Path to the generated output artifact as a whole. */
      managedArtifactPath: string;
      /** Markdown artifacts render frontmatter and body into a file. */
      artifactType: 'markdown';
      /** Markdown body written after rendered frontmatter. */
      body: string;
      /** Frontmatter metadata written to the markdown file. */
      metadata: Record<string, unknown>;
      /** Concrete markdown file path to write. */
      fileWritePath: string;
    }
  | {
      /** Agent that owns this generated artifact. */
      agent: string;
      /** Path to the generated output artifact as a whole. */
      managedArtifactPath: string;
      /** Directory artifacts copy a source directory into the managed path. */
      artifactType: 'directory';
      /** Source directory whose contents are copied into the managed path. */
      sourceDir: string;
    };

export type MarkdownArtifactSpec = Extract<
  ArtifactSpec,
  {
    artifactType: 'markdown';
  }
>;

export type DirectoryArtifactSpec = Extract<
  ArtifactSpec,
  {
    artifactType: 'directory';
  }
>;

export type MarkdownArtifactMetadata = MarkdownArtifactSpec['metadata'];

/**
 * Collects ownership key definitions from every registered agent for command, rule, and skill kinds.
 *
 * @returns An array of ownership key definition objects—one for each command, rule, and skill entry of every agent, in the iteration order of SYNC_AGENTS.
 */
function listOwnershipDefinitions() {
  return SYNC_AGENTS.flatMap((agent) => {
    const definition = AGENT_DEFINITIONS[agent];

    return [
      definition.command.ownershipKey,
      definition.rule.ownershipKey,
      definition.skill.ownershipKey,
    ];
  });
}

/**
 * Build a mapping of each agent's named target roots to their resolved filesystem paths.
 *
 * @param baseDir - Base directory used to resolve each target root's configured path segments
 * @returns A record mapping agent keys to an inner record of root name → resolved path string
 */
export function createTargetRoots(baseDir: string): TargetRoots {
  return Object.fromEntries(
    SYNC_AGENTS.map((agent) => {
      const segmentRoots = AGENT_DEFINITIONS[agent].targetRoots as Record<
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
 * Get the agent's display label for use in user-facing sync reports.
 *
 * @returns The agent's human-readable display label
 */
export function getAgentLabel(agent: SyncAgent): string {
  return AGENT_DEFINITIONS[agent].displayLabel;
}

/**
 * Returns the supported agent names joined as a natural English list.
 */
export function describeSupportedAgents(): string {
  return formatLabelList(SYNC_AGENTS.map(getAgentLabel));
}

/**
 * List all resolved target root directory paths for every sync agent.
 *
 * @param targetRoots - Mapping of agent → root name → resolved path
 * @returns An array of resolved root directory paths across all agents
 */
export function listTargetRootPaths(targetRoots: TargetRoots): string[] {
  return SYNC_AGENTS.flatMap((agent) => Object.values(targetRoots[agent]));
}

/**
 * Create an ownership key string for a specific agent item.
 *
 * @param value - The identifier or input used to construct the ownership key (format depends on `kind`)
 * @returns The ownership key for the specified `agent` and `kind`
 */
export function createOwnershipKey(
  agent: SyncAgent,
  kind: SyncItemKind,
  value: OwnershipKeyInput,
): OwnershipKey {
  switch (kind) {
    case 'command': {
      return AGENT_DEFINITIONS[agent].command.ownershipKey.createKey(value);
    }
    case 'rule': {
      return AGENT_DEFINITIONS[agent].rule.ownershipKey.createKey(value);
    }
    case 'skill': {
      return AGENT_DEFINITIONS[agent].skill.ownershipKey.createKey(value);
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
 * Collects per-agent frontmatter sections and returns them keyed by recognized sync agent.
 *
 * @param input.filePath - Source file path used in diagnostics
 * @param input.kind - Frontmatter kind, either `'command'` or `'rule'`, which determines the expected section shape
 * @param input.sections - The raw `agents` frontmatter block to collect values from
 * @returns A map from recognized `SyncAgent` to the raw section value, or `null` if any unsupported agents were present (an informational message is logged in that case)
 */
function getAgentSpecificValues<K extends 'command' | 'rule'>(
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
 * Build a command artifact spec for each supported agent based on the file's frontmatter and body.
 *
 * For agents whose `agents.<agent>` section fails the agent's frontmatter schema validation this function
 * skips that agent and records a warning; if the input contains unsupported agent names the function
 * returns `null`.
 *
 * @returns A readonly array of `ArtifactSpec` objects for the agents that produced valid specs, or `null` if no specs were produced.
 */
export function buildCommandArtifactSpecsByAgent(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    body: string;
    frontmatter: CommandFrontmatter;
    targetRoots: TargetRoots;
  },
): readonly ArtifactSpec[] | null {
  const agentSpecificValues = getAgentSpecificValues(runtime, {
    filePath: input.filePath,
    kind: 'command',
    sections: input.frontmatter.agents,
  });

  if (!agentSpecificValues) {
    return null;
  }

  const artifactSpecs: ArtifactSpec[] = [];

  for (const agent of SYNC_AGENTS) {
    const { frontmatterSectionSchema } = AGENT_DEFINITIONS[agent].command;

    const result = frontmatterSectionSchema.safeParse(
      agentSpecificValues.get(agent),
    );

    if (!result.success) {
      runtime.logWarn(
        `Skipping ${getAgentLabel(agent)} for ${input.filePath}: ${formatValidationIssues(
          {
            issues: result.error.issues,
            pathPrefix: `agents.${agent}`,
          },
        )}`,
      );
      continue;
    }

    artifactSpecs.push(
      AGENT_DEFINITIONS[agent].command.buildArtifactSpec({
        input: {
          name: input.frontmatter.name,
          description: input.frontmatter.description,
          sourceFileStem: path.basename(input.filePath, '.md'),
          body: input.body,
          ...(result.data ?? {}),
        },
        targetRoots: input.targetRoots,
      }),
    );
  }

  if (artifactSpecs.length === 0) {
    return null;
  }

  return artifactSpecs;
}

/**
 * Build one rule artifact spec for each supported agent that provides a valid `agents.<agent>` section.
 *
 * Skips agents whose frontmatter section fails schema validation (a warning is logged for each skipped agent).
 *
 * @param input - Input data for building rule artifact specs
 * @param input.filePath - Path to the source markdown file (used to derive the source name/stem)
 * @param input.body - Markdown body content
 * @param input.frontmatter - Parsed rule frontmatter for the file
 * @param input.targetRoots - Resolved target root paths per agent
 * @returns A read-only array of artifact specs for agents that passed validation, or `null` if no specs were produced
 */
export function buildRuleArtifactSpecsByAgent(
  runtime: CLIRuntime,
  input: {
    filePath: string;
    body: string;
    frontmatter: RuleFrontmatter;
    targetRoots: TargetRoots;
  },
): readonly ArtifactSpec[] | null {
  const sectionValues = getAgentSpecificValues(runtime, {
    filePath: input.filePath,
    kind: 'rule',
    sections: input.frontmatter.agents,
  });

  if (!sectionValues) {
    return null;
  }

  const artifactSpecs: ArtifactSpec[] = [];
  const baseSource: AgentRuleSource = {
    name: path.basename(input.filePath, '.md'),
    description: input.frontmatter.description,
    sourceFileStem: path.basename(input.filePath, '.md'),
    body: input.body,
  };

  for (const agent of SYNC_AGENTS) {
    const { frontmatterSectionSchema, buildArtifactSpec } =
      AGENT_DEFINITIONS[agent].rule;

    const result = frontmatterSectionSchema.safeParse(sectionValues.get(agent));

    if (!result.success) {
      runtime.logWarn(
        `Skipping ${getAgentLabel(agent)} for ${input.filePath}: ${formatValidationIssues(
          {
            issues: result.error.issues,
            pathPrefix: `agents.${agent}`,
          },
        )}`,
      );
      continue;
    }

    artifactSpecs.push(
      buildArtifactSpec({
        input: {
          ...baseSource,
          ...(result.data ?? {}),
        },
        targetRoots: input.targetRoots,
      }),
    );
  }

  if (artifactSpecs.length === 0) {
    return null;
  }

  return artifactSpecs;
}
