import { Effect, Exit, Logger } from 'effect';
import type { Layer } from 'effect/Layer';
import * as Runtime from 'effect/Runtime';

import type { CommandEnv } from '../lib/command-env.js';
import { areCliFailureDiagnosticsEnabled } from '../lib/command-options.js';

import {
  formatCliFailureDiagnostics,
  formatCliUserMessageFromCause,
} from './present-error.js';

/**
 * Thrown after the CLI records a user-facing line for an Effect failure. Carries
 * the original {@link Runtime.FiberFailure} so tests can still inspect causes.
 * {@link Error#message} is the same string sent to {@link Effect.logError}.
 */
export class CliHandledFiberFailure extends Error {
  readonly fiberFailure: Runtime.FiberFailure;

  constructor(fiberFailure: Runtime.FiberFailure, userMessage: string) {
    super(userMessage);
    this.name = 'CliHandledFiberFailure';
    this.fiberFailure = fiberFailure;
  }
}

export type CliLogSinks = {
  writeOut: (output: string) => void;
  writeErr: (output: string) => void;
};

function formatCliLogMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message
      .map((part) => (typeof part === 'string' ? part : String(part)))
      .join(' ');
  }

  return typeof message === 'string' ? message : String(message);
}

/**
 * Maps Effect's default logger to CLI stdio: informational logs to `writeOut`,
 * warnings and errors to `writeErr`, each with a trailing newline (same contract
 * as Commander-configured stdio in tests).
 */
export function createCliLoggerLayer(sinks: CliLogSinks): Layer<never> {
  const cliLogger = Logger.make<unknown, void>((options) => {
    const line = `${formatCliLogMessage(options.message)}\n`;

    switch (options.logLevel._tag) {
      case 'Fatal':
      case 'Error':
      case 'Warning':
        sinks.writeErr(line);
        break;
      default:
        sinks.writeOut(line);
        break;
    }
  });

  return Logger.replace(Logger.defaultLogger, cliLogger);
}

/**
 * Runs an already-provided effect (caller supplies layers/services). On failure,
 * logs one curated user-facing line with {@link Effect.logError}, and when
 * {@link areCliFailureDiagnosticsEnabled} is true logs a second line with the full
 * cause tree. Then throws {@link CliHandledFiberFailure}.
 */
export async function runCliEffect<A, E>(
  env: CommandEnv,
  effect: Effect.Effect<A, E, never>,
): Promise<A> {
  const instrumented = Effect.tapErrorCause(effect, (cause) =>
    Effect.gen(function* () {
      yield* Effect.logError(formatCliUserMessageFromCause(cause));
      if (areCliFailureDiagnosticsEnabled(env.rootOptions)) {
        yield* Effect.logError(formatCliFailureDiagnostics(cause));
      }
    }),
  ).pipe(Effect.provide(env.runtime.loggerLayer));

  const exit = await Effect.runPromiseExit(instrumented);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw new CliHandledFiberFailure(
    Runtime.makeFiberFailure(exit.cause),
    formatCliUserMessageFromCause(exit.cause),
  );
}
