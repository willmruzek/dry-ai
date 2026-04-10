import { InvalidArgumentError } from 'commander';
import { z } from 'zod';

export const nonEmptyOptionStringSchema = z.string().trim().min(1);

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
 * Parses one Commander option value with a Zod schema.
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
