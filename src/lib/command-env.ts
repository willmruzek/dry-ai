import type { FileSystem } from '@effect/platform/FileSystem';
import type { Layer } from 'effect/Layer';

import type { RootOptions } from './command-options.js';
import type { AgentsContext } from './context.js';

/**
 * Runtime services for command actions: Effect {@link FileSystem} provisioning
 * and routing for {@link Effect.logInfo} / {@link Effect.logWarning} / {@link Effect.logError}.
 */
export type CLIRuntime = {
  /** Layer providing `@effect/platform` {@link FileSystem} for lockfile and related I/O. */
  fileSystemLayer: Layer<FileSystem>;
  /** Routes Effect Logger output (info → stdout, warning/error → stderr) for CLI runs. */
  loggerLayer: Layer<never>;
};

/**
 * The shared environment passed into every command action: the resolved domain
 * context plus Effect runtime layers (filesystem and CLI logger routing).
 */
export type CommandEnv = {
  context: AgentsContext;
  runtime: CLIRuntime;
  rootOptions: RootOptions;
};
