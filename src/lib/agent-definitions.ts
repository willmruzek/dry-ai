import path from 'node:path';

import { Schema } from 'effect';

import { defineAgent } from './agent-definition-helpers.js';
import type {
  AgentCmdSource,
  AgentRuleSource,
  AgentSkillSource,
  CopilotRuleSource,
  CursorRuleSource,
} from './agent-types.js';
import { compactObject } from './object-helpers.js';

type ConfiguredTargetRoots = Record<string, Record<string, string>>;

const agentFrontmatterRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

/**
 * Per-agent `agents.<id>` blocks: accept any YAML object keys without dry-ai
 * policy validation; reject non-objects when the section is present.
 */
export const LooseAgentFrontmatterRecord = Schema.transform(
  Schema.NullishOr(agentFrontmatterRecord),
  Schema.UndefinedOr(agentFrontmatterRecord),
  {
    strict: false,
    decode: (value) => (value === null ? undefined : value),
    encode: (value) => value,
  },
);

export type LooseAgentFrontmatterRecord =
  typeof LooseAgentFrontmatterRecord.Type;

function metadataFromCommandInput(
  input: AgentCmdSource & Record<string, unknown>,
): Record<string, unknown> {
  const {
    name,
    description,
    sourceFileStem: _stem,
    body: _body,
    ...yaml
  } = input;
  return compactObject({ name, description, ...yaml });
}

function metadataFromRuleInput(
  input: AgentRuleSource & Record<string, unknown>,
): Record<string, unknown> {
  const {
    name: _name,
    description,
    sourceFileStem: _stem,
    body: _body,
    ...yaml
  } = input;
  return compactObject({ description, ...yaml });
}

/**
 * The central sync agent registry, mapping each agent name to its command, rule, and skill definitions.
 */
export const AGENT_DEFINITIONS = {
  copilot: defineAgent({
    displayLabel: 'Copilot',

    targetRoots: {
      prompts: ['.copilot', 'prompts'],
      instructions: ['.copilot', 'instructions'],
      skills: ['.copilot', 'skills'],
    },

    command: {
      frontmatterSectionSchema: LooseAgentFrontmatterRecord,

      ownershipKey: {
        prefix: 'copilot:prompt-path:',
        descriptionLabel: 'Copilot prompt output',
        createSuffix: (value) => value.outputPath,
      },

      buildArtifactSpec: ({
        targetRoots,
        input,
      }: {
        targetRoots: ConfiguredTargetRoots;
        input: AgentCmdSource & Record<string, unknown>;
      }) => {
        const managedArtifactPath = path.join(
          targetRoots.copilot.prompts,
          `${input.sourceFileStem}.prompt.md`,
        );

        return {
          agent: 'copilot',
          body: input.body,
          metadata: metadataFromCommandInput(input),
          managedArtifactPath,
          artifactType: 'markdown' as const,
          fileWritePath: managedArtifactPath,
        };
      },
    },

    rule: {
      frontmatterSectionSchema: LooseAgentFrontmatterRecord,

      ownershipKey: {
        prefix: 'copilot:instruction-path:',
        descriptionLabel: 'Copilot instruction output',
        createSuffix: (value) => value.outputPath,
      },

      buildArtifactSpec: ({
        targetRoots,
        input,
      }: {
        targetRoots: ConfiguredTargetRoots;
        input: CopilotRuleSource;
      }) => {
        const managedArtifactPath = path.join(
          targetRoots.copilot.instructions,
          `${input.sourceFileStem}.instructions.md`,
        );

        return {
          agent: 'copilot',
          body: input.body,
          metadata: metadataFromRuleInput(input),
          managedArtifactPath,
          artifactType: 'markdown' as const,
          fileWritePath: managedArtifactPath,
        };
      },
    },

    skill: {
      ownershipKey: {
        prefix: 'copilot:skill-name:',
        descriptionLabel: 'Copilot skill name',
        createSuffix: (value) => value.name,
      },

      buildArtifactSpec: ({
        targetRoots,
        input,
      }: {
        targetRoots: ConfiguredTargetRoots;
        input: AgentSkillSource;
      }) => ({
        agent: 'copilot',
        managedArtifactPath: path.join(targetRoots.copilot.skills, input.name),
        sourceDir: input.sourceDir,
        artifactType: 'directory' as const,
      }),
    },
  }),

  cursor: defineAgent({
    displayLabel: 'Cursor',

    targetRoots: {
      rules: ['.cursor', 'rules'],
      skills: ['.cursor', 'skills'],
    },

    command: {
      frontmatterSectionSchema: LooseAgentFrontmatterRecord,

      ownershipKey: {
        prefix: 'cursor:skill-name:',
        descriptionLabel: 'Cursor skill name',
        createSuffix: (value) => value.name,
      },

      buildArtifactSpec: ({
        targetRoots,
        input,
      }: {
        targetRoots: ConfiguredTargetRoots;
        input: AgentCmdSource & Record<string, unknown>;
      }) => {
        const managedArtifactPath = path.join(
          targetRoots.cursor.skills,
          input.name,
        );

        return {
          agent: 'cursor',
          body: input.body,
          metadata: metadataFromCommandInput(input),
          managedArtifactPath,
          artifactType: 'markdown' as const,
          fileWritePath: path.join(managedArtifactPath, 'SKILL.md'),
        };
      },
    },

    rule: {
      frontmatterSectionSchema: LooseAgentFrontmatterRecord,

      ownershipKey: {
        prefix: 'cursor:rule-path:',
        descriptionLabel: 'Cursor rule output',
        createSuffix: (value) => value.outputPath,
      },

      buildArtifactSpec: ({
        targetRoots,
        input,
      }: {
        targetRoots: ConfiguredTargetRoots;
        input: CursorRuleSource;
      }) => {
        const managedArtifactPath = path.join(
          targetRoots.cursor.rules,
          `${input.sourceFileStem}.mdc`,
        );

        return {
          agent: 'cursor',
          body: input.body,
          metadata: metadataFromRuleInput(input),
          managedArtifactPath,
          artifactType: 'markdown' as const,
          fileWritePath: managedArtifactPath,
        };
      },
    },

    skill: {
      ownershipKey: {
        prefix: 'cursor:skill-name:',
        descriptionLabel: 'Cursor skill name',
        createSuffix: (value) => value.name,
      },

      buildArtifactSpec: ({
        targetRoots,
        input,
      }: {
        targetRoots: ConfiguredTargetRoots;
        input: AgentSkillSource;
      }) => ({
        agent: 'cursor',
        managedArtifactPath: path.join(targetRoots.cursor.skills, input.name),
        sourceDir: input.sourceDir,
        artifactType: 'directory' as const,
      }),
    },
  }),
};
