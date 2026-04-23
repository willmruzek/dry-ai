import matter from 'gray-matter';
import { z } from 'zod';

import type { CLIRuntime } from '../cli.js';

export { compactObject } from './object-helpers.js';

export const nonEmptyStringSchema = z.string().trim().min(1);

/**
 * `agents` blocks are not validated with strict per-agent schemas at parse
 * time, so a valid Copilot block can coexist with an invalid Cursor block (and
 * vice versa); each agent is validated when building sync output.
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
