export const SYNC_ITEM_KINDS = ['command', 'rule', 'skill'] as const;

export type SyncItemKind = (typeof SYNC_ITEM_KINDS)[number];

export type OwnershipKeyInput = {
  name: string;
  outputPath: string;
};

export type AgentCmdSource = {
  name: string;
  description: string;
  sourceFileStem: string;
  body: string;
};

export type AgentRuleSource = {
  name: string;
  description: string;
  sourceFileStem: string;
  body: string;
};

/** Rule source plus passthrough keys from `agents.copilot` in source frontmatter. */
export type CopilotRuleSource = AgentRuleSource & Record<string, unknown>;

/** Rule source plus passthrough keys from `agents.cursor` in source frontmatter. */
export type CursorRuleSource = AgentRuleSource & Record<string, unknown>;

export type AgentSkillSource = {
  name: string;
  sourceDir: string;
};

export type AgentSourceByKind = {
  command: AgentCmdSource;
  rule: AgentRuleSource;
  skill: AgentSkillSource;
};
