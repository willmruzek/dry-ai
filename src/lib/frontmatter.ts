import matter from 'gray-matter';
import { z } from 'zod';

export const nonEmptyStringSchema = z.string().trim().min(1);

export const commandFrontmatterSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    cursor: z
      .object({
        'disable-model-invocation': z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ruleFrontmatterSchema = z
  .object({
    description: nonEmptyStringSchema,
    copilot: z
      .object({
        applyTo: nonEmptyStringSchema,
      })
      .strict(),
    cursor: z
      .object({
        alwaysApply: z.boolean().optional(),
        globs: nonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CommandFrontmatter = z.infer<typeof commandFrontmatterSchema>;
export type RuleFrontmatter = z.infer<typeof ruleFrontmatterSchema>;

/**
 * Returns a copy of an object with all undefined-valued entries removed.
 */
export function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

/**
 * Returns whether a value is a non-null plain object and not an array.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses optional YAML frontmatter from a markdown-like file and returns its metadata and body.
 */
export function parseFrontmatter(fileContent: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  const parsed = matter(fileContent);
  return {
    metadata: isPlainObject(parsed.data) ? parsed.data : {},
    body: parsed.content.trim(),
  };
}

/**
 * Validates parsed frontmatter against a schema and logs a skip message when validation fails.
 */
export function validateFrontmatter<T>({
  filePath,
  metadata,
  schema,
}: {
  filePath: string;
  metadata: Record<string, unknown>;
  schema: z.ZodType<T>;
}): T | null {
  const result = schema.safeParse(metadata);

  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues
    .map((issue) => {
      const fieldPath =
        issue.path.length > 0 ? issue.path.join('.') : 'frontmatter';
      return `${fieldPath}: ${issue.message}`;
    })
    .join('; ');

  console.log(`Skipping invalid frontmatter in ${filePath}: ${issues}`);
  return null;
}

/**
 * Normalizes rule frontmatter into the apply settings used by downstream generators.
 */
export function normalizeRuleMetadata(metadata: RuleFrontmatter): {
  alwaysApply: boolean;
  globs: string | undefined;
  applyTo: string;
} {
  const copilotApplyTo = metadata.copilot.applyTo;
  const explicitAlwaysApply = metadata.cursor?.alwaysApply;
  const scopedGlobs = metadata.cursor?.globs ?? copilotApplyTo;
  const alwaysApply =
    explicitAlwaysApply ?? (scopedGlobs === undefined || scopedGlobs === '**');
  const globs = alwaysApply ? undefined : scopedGlobs;

  return {
    alwaysApply,
    globs,
    applyTo: copilotApplyTo,
  };
}

/**
 * Renders metadata and markdown body content back into a frontmatter document string.
 */
export function renderMarkdown({
  metadata,
  body,
}: {
  metadata: Record<string, unknown>;
  body: string;
}): string {
  const normalizedBody = body.trim();
  if (Object.keys(metadata).length === 0) {
    return `${normalizedBody}\n`;
  }

  return matter.stringify(normalizedBody, metadata);
}
