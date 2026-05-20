import * as Schema from 'effect/Schema';

/**
 * Trimmed string with at least one character after trim.
 *
 * Shared by CLI options, markdown frontmatter, and other user-provided names/paths.
 */
export const NonEmptyTrimmedString = Schema.Trim.pipe(
  Schema.nonEmptyString({ identifier: 'NonEmptyTrimmedString' }),
);
