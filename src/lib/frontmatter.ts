import { Effect, Schema } from 'effect';
import * as Either from 'effect/Either';
import * as ParseResult from 'effect/ParseResult';
import matter from 'gray-matter';

import { NonEmptyTrimmedString } from './schemas.js';

export { compactObject } from './object-helpers.js';

const strictFrontmatterParseOptions = {
  errors: 'all',
  onExcessProperty: 'error',
} as const;

const LooseAgentBlocks = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

/**
 * Top-level command/rule frontmatter is strict; each `agents.<agent>` value is
 * only checked to be a plain object (or omitted) when building that agent’s
 * artifact—keys are passed through without dry-ai policy validation.
 */
export const CommandFrontmatterSchema = Schema.Struct({
  name: NonEmptyTrimmedString,
  description: NonEmptyTrimmedString,
  agents: Schema.optional(LooseAgentBlocks),
}).annotations({ parseOptions: strictFrontmatterParseOptions });

export const RuleFrontmatterSchema = Schema.Struct({
  description: NonEmptyTrimmedString,
  agents: Schema.optional(LooseAgentBlocks),
}).annotations({ parseOptions: strictFrontmatterParseOptions });

export type AgentFrontmatterSections = CommandFrontmatter['agents'];
export type CommandFrontmatter = typeof CommandFrontmatterSchema.Type;
export type RuleFrontmatter = typeof RuleFrontmatterSchema.Type;

/**
 * Returns whether a value is a non-null plain object and not an array.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parses a markdown-like file into optional YAML frontmatter metadata and body.
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
 * Validates parsed frontmatter against a schema and logs a skip message when validation fails.
 */
export function validateFrontmatter<A, I>({
  filePath,
  metadata,
  schema,
}: {
  filePath: string;
  metadata: Record<string, unknown>;
  schema: Schema.Schema<A, I, never>;
}): Effect.Effect<A | null, never, never> {
  return Effect.gen(function* () {
    const result = Schema.decodeUnknownEither(schema)(metadata, {
      errors: 'all',
      onExcessProperty: 'error',
    });

    if (Either.isRight(result)) {
      return result.right;
    }

    const issues = ParseResult.ArrayFormatter.formatIssueSync(result.left.issue)
      .map((issue) => {
        const fieldPath =
          issue.path.length > 0 ? issue.path.join('.') : 'frontmatter';
        return `${fieldPath}: ${issue.message}`;
      })
      .join('; ');

    yield* Effect.logInfo(
      `Skipping invalid frontmatter in ${filePath}: ${issues}`,
    );

    return null;
  });
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
