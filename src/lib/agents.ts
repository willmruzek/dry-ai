import path from 'node:path';

import { AGENT_DEFINITIONS } from './agent-definitions.js';
import {
  type OwnershipKeyInput,
  type AgentRuleSource,
  type SyncItemKind,
} from './agent-types.js';
import type { CLIRuntime } from './command-env.js';
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
 * Returns all ownership definitions registered across every agent and item kind.
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
 * Builds the map of output root directory paths for every agent, each resolved relative to baseDir.
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
 * Returns the display label used for one agent in user-facing sync reports.
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
 * Returns every output root directory path from the given TargetRoots map.
 */
export function listTargetRootPaths(targetRoots: TargetRoots): string[] {
  return SYNC_AGENTS.flatMap((agent) => Object.values(targetRoots[agent]));
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
 * Reads the per-agent blocks from parsed frontmatter and returns a map of agent → raw section value.
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
 * Builds one command artifact spec per agent. Skips an agent when
 * `agents.<agent>` is present but not a YAML object (records a warning).
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
 * Builds one rule artifact spec per agent. Skips an agent when
 * `agents.<agent>` is present but not a YAML object (records a warning).
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
