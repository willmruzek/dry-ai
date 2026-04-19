import os from 'node:os';
import path from 'node:path';
import { createTargetRoots, type TargetRoots } from './agents.js';

export type SourceRoots = {
  commands: string;
  rules: string;
  skills: string;
};

export type AgentsContext = {
  inputRoot: string;
  outputRoot: string;
  skillsLockfilePath: string;
  syncManifestPath: string;
  sourceRoots: SourceRoots;
  targetRoots: TargetRoots;
};

export const DEFAULT_INPUT_ROOT_SEGMENTS = ['.config', 'dryai'] as const;
export const DEFAULT_TEST_OUTPUT_DIR_NAME = 'output-test';
export const DEFAULT_SYNC_MANIFEST_FILE_NAME = 'sync-manifest.json';

export const DEFAULT_SOURCE_ROOT_NAMES = {
  commands: 'commands',
  rules: 'rules',
  skills: 'skills',
} as const;

/**
 * Creates the commands, rules, and skills input roots under one base directory.
 */
export function createSourceRoots(baseDir: string): SourceRoots {
  return {
    commands: path.join(baseDir, DEFAULT_SOURCE_ROOT_NAMES.commands),
    rules: path.join(baseDir, DEFAULT_SOURCE_ROOT_NAMES.rules),
    skills: path.join(baseDir, DEFAULT_SOURCE_ROOT_NAMES.skills),
  };
}

/**
 * Expands a leading `~` in a path to the current user's home directory.
 */
export function expandHomePath(inputPath: string, homeDir: string): string {
  if (inputPath === '~') {
    return homeDir;
  }

  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(homeDir, inputPath.slice(2));
  }

  return inputPath;
}

/**
 * Returns the explicit output root if --output-root or --test was passed, or undefined if neither was set.
 */
export function resolveRequestedOutputRoot(input: {
  test: boolean;
  outputRoot?: string;
}): string | undefined {
  if (input.outputRoot) {
    return input.outputRoot;
  }

  return input.test ? `./${DEFAULT_TEST_OUTPUT_DIR_NAME}` : undefined;
}

/**
 * Returns the --config-root value if provided, or undefined.
 */
export function resolveRequestedConfigRoot(input: {
  configRoot?: string;
}): string | undefined {
  return input.configRoot;
}

/**
 * Resolves the absolute output root path, expanding ~ and defaulting to homeDir when no override is given.
 */
export function resolveOutputRoot(input: {
  homeDir: string;
  outputRoot?: string;
}): string {
  if (input.outputRoot) {
    return path.resolve(expandHomePath(input.outputRoot, input.homeDir));
  }

  return input.homeDir;
}

/**
 * Returns a shallow copy of context with outputRoot and targetRoots updated to the given path.
 */
export function resolveOutputContext(
  context: AgentsContext,
  outputRoot: string,
): AgentsContext {
  return {
    ...context,
    outputRoot,
    targetRoots: createTargetRoots(outputRoot),
  };
}

/**
 * Builds the AgentsContext by resolving input and output roots, applying ~ expansion and test-mode defaults.
 */
export function createAgentsContext(options?: {
  inputRoot?: string;
  outputRoot?: string;
}): AgentsContext {
  const homeDir = os.homedir();
  const inputRoot = options?.inputRoot
    ? path.resolve(expandHomePath(options.inputRoot, homeDir))
    : path.join(homeDir, ...DEFAULT_INPUT_ROOT_SEGMENTS);
  const outputRoot = resolveOutputRoot(
    options?.outputRoot
      ? {
          homeDir,
          outputRoot: options.outputRoot,
        }
      : {
          homeDir,
        },
  );

  return {
    inputRoot,
    outputRoot,
    skillsLockfilePath: path.join(inputRoot, 'skills.lock.json'),
    syncManifestPath: path.join(inputRoot, DEFAULT_SYNC_MANIFEST_FILE_NAME),
    sourceRoots: createSourceRoots(inputRoot),
    targetRoots: createTargetRoots(outputRoot),
  };
}
