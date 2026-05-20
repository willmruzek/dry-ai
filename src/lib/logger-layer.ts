import { Logger } from 'effect';
import type { Layer } from 'effect/Layer';

/**
 * Formats the payload passed to {@link Effect.logInfo} and related APIs for CLI output.
 */
export function formatLogMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message
      .map((part) => (typeof part === 'string' ? part : String(part)))
      .join(' ');
  }

  return typeof message === 'string' ? message : String(message);
}

/**
 * Logger that prints only the log message (no logfmt / fiber metadata).
 * Info and below go to `writeOut`; warnings and errors go to `writeErr`.
 */
export function createMessageOnlyLoggerLayer(handlers: {
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
}): Layer<never> {
  const logger = Logger.make<unknown, void>((opts) => {
    const line = `${formatLogMessage(opts.message)}\n`;

    switch (opts.logLevel._tag) {
      case 'Fatal':
      case 'Error':
      case 'Warning':
        handlers.writeErr(line);
        break;
      default:
        handlers.writeOut(line);
        break;
    }
  });

  return Logger.replace(Logger.defaultLogger, logger);
}

/** Production CLI logger: plain messages on stdout/stderr. */
export function createProductionLoggerLayer(): Layer<never> {
  return createMessageOnlyLoggerLayer({
    writeOut: (line) => {
      process.stdout.write(line);
    },
    writeErr: (line) => {
      process.stderr.write(line);
    },
  });
}
