import { InvalidArgumentError } from 'commander';
import { z } from 'zod';

export const nonEmptyOptionStringSchema = z.string().trim().min(1);

export const rootOptionsSchema = z.object({
  test: z.boolean().optional().default(false),
  debug: z.boolean().optional().default(false),
  configRoot: nonEmptyOptionStringSchema.optional(),
  outputRoot: nonEmptyOptionStringSchema.optional(),
});

export type RootOptions = z.output<typeof rootOptionsSchema>;

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
 * Parses a value with a Zod schema, throwing a Commander InvalidArgumentError on failure.
 */
function parseWithSchema<TSchema extends z.ZodTypeAny>({
  schema,
  value,
  label,
}: {
  schema: TSchema;
  value: unknown;
  label: string;
}): z.output<TSchema> {
  const result = schema.safeParse(value);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${issuePath}${issue.message}`;
    })
    .join('; ');

  throw new InvalidArgumentError(`${label}: ${issues}`);
}

/**
 * Returns a Commander option parser function that validates the raw string value with the given Zod schema.
 */
export function parseOptionValue<TSchema extends z.ZodTypeAny>({
  schema,
  optionLabel,
}: {
  schema: TSchema;
  optionLabel: string;
}): (value: z.input<TSchema>) => z.output<TSchema> {
  return (value) => parseWithSchema({ schema, value, label: optionLabel });
}

/**
 * Parses a Commander options object with a Zod schema.
 */
export function parseOptionsObject<TSchema extends z.ZodTypeAny>({
  schema,
  options,
  optionsLabel,
}: {
  schema: TSchema;
  options: unknown;
  optionsLabel: string;
}): z.output<TSchema> {
  return parseWithSchema({ schema, value: options, label: optionsLabel });
}
