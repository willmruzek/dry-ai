import matter from 'gray-matter';
import { z } from 'zod';

import type { CLIRuntime } from '../cli.js';

export { compactObject } from './object-helpers.js';

export const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * Top-level command/rule frontmatter is strict; each `agents.<agent>` value is
 * only checked to be a plain object (or omitted) when building that agent’s
 * artifact—keys are passed through without dry-ai policy validation.
 */
const looseAgentBlocksSchema = z.record(z.string(), z.unknown()).optional();

export const commandFrontmatterSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    agents: looseAgentBlocksSchema,
  })
  .strict();

export const ruleFrontmatterSchema = z
  .object({
    description: nonEmptyStringSchema,
    agents: looseAgentBlocksSchema,
  })
  .strict();

export type AgentFrontmatterSections = z.infer<typeof looseAgentBlocksSchema>;
export type CommandFrontmatter = z.infer<typeof commandFrontmatterSchema>;
export type RuleFrontmatter = z.infer<typeof ruleFrontmatterSchema>;

/**
 * Checks whether a value is a non-null object that is not an array.
 *
 * @returns `true` if `value` is an object (not `null`) and not an array, `false` otherwise.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts YAML frontmatter metadata and the trimmed body from a Markdown string.
 *
 * @param fileContent - The Markdown document to parse; may include YAML frontmatter
 * @returns An object with `metadata` set to the parsed frontmatter as a plain object (or `{}` when absent or not a plain object) and `body` set to the trimmed document content
 */
export function parseMdWithFrontmatter(fileContent: string): {
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
 * Validate frontmatter metadata against a Zod schema and return the validated value or `null`; logs an informational skip message if validation fails.
 *
 * @param filePath - Path of the source file whose frontmatter is being validated (used in the logged message)
 * @param metadata - Parsed frontmatter object to validate
 * @param schema - Zod schema used to validate `metadata`
 * @returns `T` if validation succeeds, `null` otherwise
 */
export function validateFrontmatter<T>(
  runtime: CLIRuntime,
  {
    filePath,
    metadata,
    schema,
  }: {
    filePath: string;
    metadata: Record<string, unknown>;
    schema: z.ZodType<T>;
  },
): T | null {
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

  runtime.logInfo(`Skipping invalid frontmatter in ${filePath}: ${issues}`);

  return null;
}

/**
 * Serializes metadata as YAML frontmatter and combines it with the markdown body into a single document string.
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
