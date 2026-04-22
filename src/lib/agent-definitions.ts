import path from 'node:path';

import { z } from 'zod';

import {
  defineAgentFrontmatterSection,
  defineMetadata,
  defineOutputPathCreators,
  defineOwnershipKey,
  defineTarget,
} from './agent-definition-helpers.js';
import type {
  AgentCmdSyncSpec,
  AgentRuleSyncSpec,
  AgentSkillSyncSpec,
} from './agent-types.js';
import { compactObject } from './object-helpers.js';

type ConfiguredTargetRoots = Record<string, Record<string, string>>;
const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * The central sync agent registry, mapping each agent name to its command, rule, and skill definitions.
 */
export const AGENT_DEFINITIONS = {
  copilot: {
    displayLabel: 'Copilot',
    targetRoots: {
      prompts: ['.copilot', 'prompts'],
      instructions: ['.copilot', 'instructions'],
      skills: ['.copilot', 'skills'],
    },
    command: (() => {
      const outputPathCreators =
        defineOutputPathCreators<ConfiguredTargetRoots>({
          createTargetPath: ({ targetRoots, sourceFileStem }) =>
            path.join(
              targetRoots.copilot.prompts,
              `${sourceFileStem}.prompt.md`,
            ),
        });
      const frontmatterSectionSchema = z.strictObject({}).optional();
      const metadata = defineMetadata<
        { name: string; description: string },
        {
          name: z.ZodString;
          description: z.ZodString;
        }
      >({
        shape: {
          name: z.string().min(1),
          description: z.string().min(1),
        },
        buildMetadata: (value) =>
          compactObject({
            name: value.name,
            description: value.description,
          }),
      });

      return {
        frontmatterSection: defineAgentFrontmatterSection<
          z.output<typeof frontmatterSectionSchema>,
          AgentCmdSyncSpec
        >({
          schema: frontmatterSectionSchema,
          extendSyncInput: () => ({}),
        }),
        ownershipKey: defineOwnershipKey({
          prefix: 'copilot:prompt-path:',
          descriptionLabel: 'Copilot prompt output',
          selectSuffix: (value) => value.outputPath,
        }),
        outputPathCreators,
        metadata,
        target: defineTarget({
          buildTarget: ({
            targetRoots,
            input,
          }: {
            targetRoots: ConfiguredTargetRoots;
            input: AgentCmdSyncSpec;
          }) => {
            const outputPath = outputPathCreators.createTargetPath({
              targetRoots,
              itemName: input.name,
              sourceFileStem: input.sourceFileStem,
            });

            return {
              agent: 'copilot',
              body: input.body,
              metadata: metadata.create({
                name: input.name,
                description: input.description,
              }),
              outputPath,
              targetType: 'markdown' as const,
              writePath: outputPath,
            };
          },
        }),
      };
    })(),
    rule: (() => {
      const outputPathCreators =
        defineOutputPathCreators<ConfiguredTargetRoots>({
          createTargetPath: ({ targetRoots, sourceFileStem }) =>
            path.join(
              targetRoots.copilot.instructions,
              `${sourceFileStem}.instructions.md`,
            ),
        });
      const frontmatterSectionSchema = z.strictObject({
        applyTo: nonEmptyStringSchema,
      });
      const metadata = defineMetadata<
        { description: string; applyTo: string },
        {
          description: z.ZodString;
          applyTo: z.ZodString;
        }
      >({
        shape: {
          description: z.string().min(1),
          applyTo: z.string().min(1),
        },
        buildMetadata: (value) =>
          compactObject({
            description: value.description,
            applyTo: value.applyTo,
          }),
      });

      return {
        frontmatterSection: defineAgentFrontmatterSection<
          z.output<typeof frontmatterSectionSchema>,
          AgentRuleSyncSpec
        >({
          schema: frontmatterSectionSchema,
          extendSyncInput: (value) => ({
            applyTo: value.applyTo,
          }),
        }),
        ownershipKey: defineOwnershipKey({
          prefix: 'copilot:instruction-path:',
          descriptionLabel: 'Copilot instruction output',
          selectSuffix: (value) => value.outputPath,
        }),
        outputPathCreators,
        metadata,
        target: defineTarget({
          buildTarget: ({
            targetRoots,
            input,
          }: {
            targetRoots: ConfiguredTargetRoots;
            input: AgentRuleSyncSpec;
          }) => {
            const outputPath = outputPathCreators.createTargetPath({
              targetRoots,
              itemName: input.name,
              sourceFileStem: input.sourceFileStem,
            });

            return {
              agent: 'copilot',
              body: input.body,
              metadata: metadata.create({
                description: input.description,
                applyTo: input.applyTo,
              }),
              outputPath,
              targetType: 'markdown' as const,
              writePath: outputPath,
            };
          },
        }),
      };
    })(),
    skill: (() => {
      const outputPathCreators =
        defineOutputPathCreators<ConfiguredTargetRoots>({
          createTargetPath: ({ targetRoots, itemName }) =>
            path.join(targetRoots.copilot.skills, itemName),
        });

      return {
        ownershipKey: defineOwnershipKey({
          prefix: 'copilot:skill-name:',
          descriptionLabel: 'Copilot skill name',
          selectSuffix: (value) => value.name,
        }),
        outputPathCreators,
        target: defineTarget({
          buildTarget: ({
            targetRoots,
            input,
          }: {
            targetRoots: ConfiguredTargetRoots;
            input: AgentSkillSyncSpec;
          }) => ({
            agent: 'copilot',
            outputPath: outputPathCreators.createTargetPath({
              targetRoots,
              itemName: input.name,
              sourceFileStem: input.name,
            }),
            sourceDir: input.sourceDir,
            targetType: 'directory' as const,
          }),
        }),
      };
    })(),
  },
  cursor: {
    displayLabel: 'Cursor',
    targetRoots: {
      rules: ['.cursor', 'rules'],
      skills: ['.cursor', 'skills'],
    },
    command: (() => {
      const outputPathCreators =
        defineOutputPathCreators<ConfiguredTargetRoots>({
          createTargetPath: ({ targetRoots, itemName }) =>
            path.join(targetRoots.cursor.skills, itemName),
          createWritePath: (targetPath) => path.join(targetPath, 'SKILL.md'),
        });
      const frontmatterSectionSchema = z
        .strictObject({
          'disable-model-invocation': z.boolean().optional(),
        })
        .optional();
      const metadata = defineMetadata<
        {
          name: string;
          description: string;
          disableModelInvocation: boolean | undefined;
        },
        {
          name: z.ZodString;
          description: z.ZodString;
          'disable-model-invocation': z.ZodOptional<z.ZodBoolean>;
        }
      >({
        shape: {
          name: z.string().min(1),
          description: z.string().min(1),
          'disable-model-invocation': z.boolean().optional(),
        },
        buildMetadata: (value) =>
          compactObject({
            name: value.name,
            description: value.description,
            'disable-model-invocation': value.disableModelInvocation,
          }),
      });

      return {
        frontmatterSection: defineAgentFrontmatterSection<
          z.output<typeof frontmatterSectionSchema>,
          AgentCmdSyncSpec
        >({
          schema: frontmatterSectionSchema,
          extendSyncInput: (value) => ({
            disableModelInvocation: value?.['disable-model-invocation'],
          }),
        }),
        ownershipKey: defineOwnershipKey({
          prefix: 'cursor:skill-name:',
          descriptionLabel: 'Cursor skill name',
          selectSuffix: (value) => value.name,
        }),
        outputPathCreators,
        metadata,
        target: defineTarget({
          buildTarget: ({
            targetRoots,
            input,
          }: {
            targetRoots: ConfiguredTargetRoots;
            input: AgentCmdSyncSpec;
          }) => {
            const outputPath = outputPathCreators.createTargetPath({
              targetRoots,
              itemName: input.name,
              sourceFileStem: input.sourceFileStem,
            });

            return {
              agent: 'cursor',
              body: input.body,
              metadata: metadata.create({
                name: input.name,
                description: input.description,
                disableModelInvocation: input.disableModelInvocation,
              }),
              outputPath,
              targetType: 'markdown' as const,
              writePath: outputPathCreators.createWritePath(outputPath),
            };
          },
        }),
      };
    })(),
    rule: (() => {
      const outputPathCreators =
        defineOutputPathCreators<ConfiguredTargetRoots>({
          createTargetPath: ({ targetRoots, sourceFileStem }) =>
            path.join(targetRoots.cursor.rules, `${sourceFileStem}.mdc`),
        });
      const frontmatterSectionSchema = z
        .strictObject({
          alwaysApply: z.boolean().optional(),
          globs: nonEmptyStringSchema.optional(),
        })
        .optional();
      const metadata = defineMetadata<
        {
          description: string;
          globs: string | undefined;
          alwaysApply: boolean;
        },
        {
          description: z.ZodString;
          globs: z.ZodOptional<z.ZodString>;
          alwaysApply: z.ZodBoolean;
        }
      >({
        shape: {
          description: z.string().min(1),
          globs: z.string().min(1).optional(),
          alwaysApply: z.boolean(),
        },
        buildMetadata: (value) =>
          compactObject({
            description: value.description,
            globs: value.globs,
            alwaysApply: value.alwaysApply,
          }),
      });

      return {
        frontmatterSection: defineAgentFrontmatterSection<
          z.output<typeof frontmatterSectionSchema>,
          AgentRuleSyncSpec
        >({
          schema: frontmatterSectionSchema,
          extendSyncInput: (value, { currentInput }) => {
            const scopedGlobs = value?.globs ?? currentInput.applyTo;
            const alwaysApply =
              value?.alwaysApply ??
              (scopedGlobs === undefined || scopedGlobs === '**');

            return {
              alwaysApply,
              globs: alwaysApply ? undefined : scopedGlobs,
            };
          },
        }),
        ownershipKey: defineOwnershipKey({
          prefix: 'cursor:rule-path:',
          descriptionLabel: 'Cursor rule output',
          selectSuffix: (value) => value.outputPath,
        }),
        outputPathCreators,
        metadata,
        target: defineTarget({
          buildTarget: ({
            targetRoots,
            input,
          }: {
            targetRoots: ConfiguredTargetRoots;
            input: AgentRuleSyncSpec;
          }) => {
            const outputPath = outputPathCreators.createTargetPath({
              targetRoots,
              itemName: input.name,
              sourceFileStem: input.sourceFileStem,
            });

            return {
              agent: 'cursor',
              body: input.body,
              metadata: metadata.create({
                description: input.description,
                globs: input.globs,
                alwaysApply: input.alwaysApply,
              }),
              outputPath,
              targetType: 'markdown' as const,
              writePath: outputPath,
            };
          },
        }),
      };
    })(),
    skill: (() => {
      const outputPathCreators =
        defineOutputPathCreators<ConfiguredTargetRoots>({
          createTargetPath: ({ targetRoots, itemName }) =>
            path.join(targetRoots.cursor.skills, itemName),
        });

      return {
        ownershipKey: defineOwnershipKey({
          prefix: 'cursor:skill-name:',
          descriptionLabel: 'Cursor skill name',
          selectSuffix: (value) => value.name,
        }),
        outputPathCreators,
        target: defineTarget({
          buildTarget: ({
            targetRoots,
            input,
          }: {
            targetRoots: ConfiguredTargetRoots;
            input: AgentSkillSyncSpec;
          }) => ({
            agent: 'cursor',
            outputPath: outputPathCreators.createTargetPath({
              targetRoots,
              itemName: input.name,
              sourceFileStem: input.name,
            }),
            sourceDir: input.sourceDir,
            targetType: 'directory' as const,
          }),
        }),
      };
    })(),
  },
} as const;
