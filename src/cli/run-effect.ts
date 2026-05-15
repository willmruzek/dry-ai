import { Effect, Exit } from 'effect';
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
  );

  const toRun =
    env.runtime.loggerLayer !== undefined
      ? instrumented.pipe(Effect.provide(env.runtime.loggerLayer))
      : instrumented;

  const exit = await Effect.runPromiseExit(toRun);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  throw new CliHandledFiberFailure(
    Runtime.makeFiberFailure(exit.cause),
    formatCliUserMessageFromCause(exit.cause),
  );
}
