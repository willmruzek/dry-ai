import matter from 'gray-matter';
import { z } from 'zod';

import type { CLIRuntime } from '../cli.js';

import { AGENT_DEFINITIONS } from './agent-definitions.js';

export { compactObject } from './object-helpers.js';

export const nonEmptyStringSchema = z.string().trim().min(1);

export const agentFrontmatterSectionSchema = z.object({}).catchall(z.unknown());

export const agentFrontmatterSectionsSchema = z
  .record(z.string(), agentFrontmatterSectionSchema)
  .optional();

/**
 * Builds the Zod schema for the `agents:` frontmatter section by combining each agent's per-kind source schema from the registry.
 */
export function createAgentFrontmatterSectionsSchema(kind: 'command' | 'rule') {
  const shape: Record<string, z.ZodType<unknown>> = {};

  for (const [agent, definition] of Object.entries(AGENT_DEFINITIONS)) {
    shape[agent] = definition[kind].frontmatterSection.schema;
  }

  return z.object(shape).catchall(agentFrontmatterSectionSchema).optional();
}

export const commandAgentFrontmatterSectionsSchema =
  createAgentFrontmatterSectionsSchema('command');

export const ruleAgentFrontmatterSectionsSchema =
  createAgentFrontmatterSectionsSchema('rule');

export const commandFrontmatterSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    agents: commandAgentFrontmatterSectionsSchema,
  })
  .strict();

export const ruleFrontmatterSchema = z
  .object({
    description: nonEmptyStringSchema,
    agents: ruleAgentFrontmatterSectionsSchema,
  })
  .strict();

export type AgentFrontmatterSections = z.infer<
  typeof agentFrontmatterSectionsSchema
>;
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
