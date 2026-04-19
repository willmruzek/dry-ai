import type { TargetRoots } from './agents.js';

export const SYNC_ITEM_KINDS = ['command', 'rule', 'skill'] as const;

export type SyncItemKind = (typeof SYNC_ITEM_KINDS)[number];

export type OwnershipKeyInput = {
  name: string;
  outputPath: string;
};

export type AgentCmdSyncSpec = {
  name: string;
  description: string;
  sourceFileStem: string;
  body: string;
  disableModelInvocation: boolean | undefined;
};

export type AgentRuleSyncSpec = {
  name: string;
  description: string;
  sourceFileStem: string;
  body: string;
  applyTo: string;
  globs: string | undefined;
  alwaysApply: boolean;
};

export type AgentSkillSyncSpec = {
  name: string;
  sourceDir: string;
};

export type AgentSyncSpecByKind = {
  command: AgentCmdSyncSpec;
  rule: AgentRuleSyncSpec;
  skill: AgentSkillSyncSpec;
};

export type SyncTargetSpec =
  | {
      kind: 'command';
      input: AgentCmdSyncSpec;
      targetRoots: TargetRoots;
    }
  | {
      kind: 'rule';
      input: AgentRuleSyncSpec;
      targetRoots: TargetRoots;
    }
  | {
      kind: 'skill';
      input: AgentSkillSyncSpec;
      targetRoots: TargetRoots;
    };
