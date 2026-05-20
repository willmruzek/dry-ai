import { InvalidArgumentError } from 'commander';
import * as Either from 'effect/Either';
import * as ParseResult from 'effect/ParseResult';
import * as Schema from 'effect/Schema';
import type { ParseOptions } from 'effect/SchemaAST';

import { NonEmptyTrimmedString } from './schemas.js';

const effectParseOptions = {
  errors: 'all',
} as const satisfies ParseOptions;

/**
 * Effect Schema for top-level CLI options (decoded shape).
 */
export const RootOptionsSchema = Schema.Struct({
  test: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  debug: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  configRoot: Schema.optional(NonEmptyTrimmedString),
  outputRoot: Schema.optional(NonEmptyTrimmedString),
});

export type RootOptions = typeof RootOptionsSchema.Type;

/**
 * Whether CLI failure diagnostics are enabled (`--debug` or `DRY_AI_DEBUG`).
 *
 * When true, the CLI logs the curated user-facing failure line plus a second
 * stderr line with the full Effect cause tree (`Cause.pretty`).
 *
 * Enabled by `--debug` or `DRY_AI_DEBUG=1` / `true` / `yes` (case-insensitive).
 */
export function areCliFailureDiagnosticsEnabled(root: RootOptions): boolean {
  if (root.debug) {
    return true;
  }
  const fromEnv = process.env.DRY_AI_DEBUG;
  if (fromEnv === undefined) {
    return false;
  }
  const normalized = fromEnv.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * Whether `--test` or `--output-root` was passed so output is written outside the default home layout.
 */
export function wasRequestedOutputRootUsed(rootOptions: RootOptions): boolean {
  return rootOptions.test || rootOptions.outputRoot !== undefined;
}

function formatEffectParseIssues(issue: ParseResult.ParseIssue): string {
  return ParseResult.ArrayFormatter.formatIssueSync(issue)
    .map((item) => {
      const issuePath = item.path.length > 0 ? `${item.path.join('.')}: ` : '';
      return `${issuePath}${item.message}`;
    })
    .join('; ');
}

/**
 * Parses a value with an Effect Schema, throwing a Commander InvalidArgumentError on failure.
 */
function parseWithEffectSchema<A, I>({
  schema,
  value,
  label,
}: {
  schema: Schema.Schema<A, I, never>;
  value: unknown;
  label: string;
}): A {
  const result = Schema.decodeUnknownEither(schema)(value, effectParseOptions);

  if (Either.isRight(result)) {
    return result.right;
  }

  throw new InvalidArgumentError(
    `${label}: ${formatEffectParseIssues(result.left.issue)}`,
  );
}

/**
 * Returns a Commander option parser that validates the raw string with an Effect Schema.
 */
export function parseOptionValue<A, I>({
  schema,
  optionLabel,
}: {
  schema: Schema.Schema<A, I, never>;
  optionLabel: string;
}): (value: I) => A {
  return (value) =>
    parseWithEffectSchema({ schema, value, label: optionLabel });
}

/**
 * Parses a Commander options object with an Effect Schema.
 */
export function parseOptionsObject<A, I>({
  schema,
  options,
  optionsLabel,
}: {
  schema: Schema.Schema<A, I, never>;
  options: unknown;
  optionsLabel: string;
}): A {
  return parseWithEffectSchema({
    schema,
    value: options,
    label: optionsLabel,
  });
}
