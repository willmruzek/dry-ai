import os from 'node:os';
import path from 'node:path';

export type TargetRoots = {
  copilotPrompts: string;
  copilotInstructions: string;
  copilotSkills: string;
  cursorRules: string;
  cursorSkills: string;
};

export type SourceRoots = {
  commands: string;
  rules: string;
  skills: string;
};

export type AgentsContext = {
  inputRoot: string;
  outputRoot: string;
  skillsLockfilePath: string;
  sourceRoots: SourceRoots;
  targetRoots: TargetRoots;
};

export const DEFAULT_INPUT_ROOT_SEGMENTS = ['.config', 'dryai'] as const;
export const DEFAULT_TEST_OUTPUT_DIR_NAME = 'output-test';

export const DEFAULT_SOURCE_ROOT_NAMES = {
  commands: 'commands',
  rules: 'rules',
  skills: 'skills',
} as const;

export const DEFAULT_TARGET_ROOT_SEGMENTS = {
  copilotPrompts: ['.copilot', 'prompts'],
  copilotInstructions: ['.copilot', 'instructions'],
  copilotSkills: ['.copilot', 'skills'],
  cursorRules: ['.cursor', 'rules'],
  cursorSkills: ['.cursor', 'skills'],
} as const;

/**
 * Creates the Copilot and Cursor output root paths under one base directory.
 */
export function createTargetRoots(baseDir: string): TargetRoots {
  return {
    copilotPrompts: path.join(
      baseDir,
      ...DEFAULT_TARGET_ROOT_SEGMENTS.copilotPrompts,
    ),
    copilotInstructions: path.join(
      baseDir,
      ...DEFAULT_TARGET_ROOT_SEGMENTS.copilotInstructions,
    ),
    copilotSkills: path.join(
      baseDir,
      ...DEFAULT_TARGET_ROOT_SEGMENTS.copilotSkills,
    ),
    cursorRules: path.join(
      baseDir,
      ...DEFAULT_TARGET_ROOT_SEGMENTS.cursorRules,
    ),
    cursorSkills: path.join(
      baseDir,
      ...DEFAULT_TARGET_ROOT_SEGMENTS.cursorSkills,
    ),
  };
}

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
 * Returns the requested output-root override derived from CLI-style options.
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
 * Returns the requested config root derived from CLI-style options.
 */
export function resolveRequestedConfigRoot(input: {
  configRoot?: string;
}): string | undefined {
  return input.configRoot;
}

/**
 * Returns the filesystem path to use for generated output.
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
 * Returns a copy of the context with generated output redirected under one
 * explicit output root.
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
 * Creates the base CLI context with repository, input, and output paths
 * resolved.
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
    sourceRoots: createSourceRoots(inputRoot),
    targetRoots: createTargetRoots(outputRoot),
  };
}
