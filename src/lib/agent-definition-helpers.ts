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
 * Defines one ownership-key namespace and how to derive keys within it.
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

function defineSource<TSource extends SourceDefinitionConfig>(
  source: TSource,
): DefinedSource<TSource> {
  return {
    ...source,
    ownershipKey: defineOwnershipKey(source.ownershipKey),
  };
}

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
