import type { OwnershipKeyInput } from './agent-types.js';

type OwnershipKeyConfig = {
  prefix: string;
  descriptionLabel: string;
  createSuffix: (value: OwnershipKeyInput) => string;
};

type DefinedOwnershipKey = {
  prefix: string;
  descriptionLabel: string;
  createKey: (value: OwnershipKeyInput) => string;
};

type SourceDefinitionConfig = {
  ownershipKey: OwnershipKeyConfig;
};

type DefinedSource<TSource extends SourceDefinitionConfig> = Omit<
  TSource,
  'ownershipKey'
> & {
  ownershipKey: DefinedOwnershipKey;
};

/**
 * Create a defined ownership-key namespace from the provided configuration.
 *
 * @param input - Configuration with `prefix`, `descriptionLabel`, and `createSuffix` used to derive keys
 * @returns An object exposing `prefix`, `descriptionLabel`, and `createKey(value)` which produces a key by concatenating the configured `prefix` with the suffix produced for `value`
 */
function defineOwnershipKey(input: OwnershipKeyConfig): DefinedOwnershipKey {
  return {
    prefix: input.prefix,
    descriptionLabel: input.descriptionLabel,
    createKey(value) {
      return `${input.prefix}${input.createSuffix(value)}`;
    },
  };
}

/**
 * Convert a source configuration by replacing its `ownershipKey` with a defined ownership key.
 *
 * @returns The original `source` object with `ownershipKey` replaced by a `DefinedOwnershipKey` containing `prefix`, `descriptionLabel`, and `createKey`.
 */
function defineSource<TSource extends SourceDefinitionConfig>(
  source: TSource,
): DefinedSource<TSource> {
  return {
    ...source,
    ownershipKey: defineOwnershipKey(source.ownershipKey),
  };
}

/**
 * Produces a new agent object where the `command`, `rule`, and `skill` sources are converted to their defined variants.
 *
 * @param agent - An agent definition containing `command`, `rule`, and `skill` as SourceDefinitionConfig objects
 * @returns The input agent with `command`, `rule`, and `skill` replaced by their corresponding DefinedSource forms (each has a derived `ownershipKey`)
 */
export function defineAgent<
  const TAgent extends {
    command: SourceDefinitionConfig;
    rule: SourceDefinitionConfig;
    skill: SourceDefinitionConfig;
  },
>(
  agent: TAgent,
): Omit<TAgent, 'command' | 'rule' | 'skill'> & {
  command: DefinedSource<TAgent['command']>;
  rule: DefinedSource<TAgent['rule']>;
  skill: DefinedSource<TAgent['skill']>;
} {
  return {
    ...agent,
    command: defineSource(agent.command),
    rule: defineSource(agent.rule),
    skill: defineSource(agent.skill),
  };
}
