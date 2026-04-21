import { z } from 'zod';

import type { OwnershipKeyInput } from './agent-types.js';

type CreateTargetPathInput<TargetRoots> = {
  targetRoots: TargetRoots;
  itemName: string;
  sourceFileStem: string;
};

type BuildTargetInput<Input, TargetRoots> = {
  targetRoots: TargetRoots;
  input: Input;
};

type AgentFrontmatterSectionEnv<SyncItemSpec> = {
  currentInput: SyncItemSpec;
  sectionValues: ReadonlyMap<string, unknown>;
};

/**
 * Defines the ownership key namespace for one agent output type, providing a typed prefix and key-derivation functions.
 */
export function defineOwnershipKey<Prefix extends string>(input: {
  prefix: Prefix;
  descriptionLabel: string;
  selectSuffix: (value: OwnershipKeyInput) => string;
}): {
  prefix: Prefix;
  descriptionLabel: string;
  createKey: (value: string) => `${Prefix}${string}`;
  createKeyForInput: (value: OwnershipKeyInput) => `${Prefix}${string}`;
} {
  return {
    prefix: input.prefix,
    descriptionLabel: input.descriptionLabel,
    createKey(value) {
      return `${input.prefix}${value}`;
    },
    createKeyForInput(value) {
      return `${input.prefix}${input.selectSuffix(value)}`;
    },
  };
}

/**
 * Defines a strict Zod schema and a `create` method for building validated frontmatter metadata objects.
 */
export function defineMetadata<Input, Shape extends z.ZodRawShape>(input: {
  shape: Shape;
  buildMetadata: (value: Input) => Record<string, unknown>;
}): {
  schema: z.ZodObject<Shape, z.core.$strict>;
  create: (value: Input) => z.output<z.ZodObject<Shape, z.core.$strict>>;
} {
  const schema = z.strictObject(input.shape);

  return {
    schema,
    create(value) {
      return schema.parse(input.buildMetadata(value));
    },
  };
}

/**
 * Defines how to compute the outputPath and writePath for a sync target from target roots and source file metadata.
 */
export function defineOutputPathCreators<TargetRoots>(input: {
  createTargetPath: (value: CreateTargetPathInput<TargetRoots>) => string;
  createWritePath?: (targetPath: string) => string;
}): {
  createTargetPath: (value: CreateTargetPathInput<TargetRoots>) => string;
  createWritePath: (targetPath: string) => string;
} {
  return {
    createTargetPath: input.createTargetPath,
    createWritePath(targetPath) {
      return input.createWritePath?.(targetPath) ?? targetPath;
    },
  };
}

/**
 * Wraps a typed buildTarget function for use in an agent's sync target definition.
 */
export function defineTarget<Input, Target, TargetRoots = unknown>(input: {
  buildTarget: (value: BuildTargetInput<Input, TargetRoots>) => Target;
}): {
  buildTarget: (value: BuildTargetInput<Input, TargetRoots>) => Target;
} {
  return {
    buildTarget: input.buildTarget,
  };
}

/**
 * Defines a validated frontmatter section that parses its value with a Zod schema and merges extra fields into the sync input.
 */
export function defineAgentFrontmatterSection<
  Section,
  SyncItemSpec extends Record<string, unknown>,
>(input: {
  schema: z.ZodType<Section>;
  extendSyncInput: (
    value: Section,
    context: AgentFrontmatterSectionEnv<SyncItemSpec>,
  ) => Partial<SyncItemSpec>;
}): {
  schema: z.ZodType<Section>;
  createSyncInputExtension: (
    value: unknown,
    context: AgentFrontmatterSectionEnv<SyncItemSpec>,
  ) =>
    | {
        success: true;
        data: Partial<SyncItemSpec>;
      }
    | {
        success: false;
        issues: readonly z.ZodIssue[];
      };
} {
  return {
    schema: input.schema,
    createSyncInputExtension(value, context) {
      const result = input.schema.safeParse(value);

      if (!result.success) {
        return {
          success: false,
          issues: result.error.issues,
        };
      }

      return {
        success: true,
        data: input.extendSyncInput(result.data, context),
      };
    },
  };
}
