import type { SyncAgent, TargetRoots } from './agents.js';

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
      /** When set, only these agents get outputs; omit to sync all agents. */
      agents?: readonly SyncAgent[];
    }
  | {
      kind: 'rule';
      input: AgentRuleSyncSpec;
      targetRoots: TargetRoots;
      /** When set, only these agents get outputs; omit to sync all agents. */
      agents?: readonly SyncAgent[];
    }
  | {
      kind: 'skill';
      input: AgentSkillSyncSpec;
      targetRoots: TargetRoots;
    };
