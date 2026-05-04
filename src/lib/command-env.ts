import type { FileSystem } from '@effect/platform/FileSystem';
import type { Layer } from 'effect/Layer';

import type { AgentsContext } from './context.js';

/**
 * Runtime services for command actions: line-oriented CLI output and Effect
 * {@link FileSystem} provisioning.
 */
export type CLIRuntime = {
  /** Writes an informational message to stdout, with an appended newline. */
  logInfo: (message: string) => void;
  /** Writes a warning message to stderr, with an appended newline. */
  logWarn: (message: string) => void;
  /** Layer providing `@effect/platform` {@link FileSystem} for lockfile and related I/O. */
  fileSystemLayer: Layer<FileSystem>;
};

/**
 * The shared environment passed into every command action: the resolved domain
 * context plus the runtime used for CLI output and Effect FS.
 */
export type CommandEnv = {
  context: AgentsContext;
  runtime: CLIRuntime;
};
