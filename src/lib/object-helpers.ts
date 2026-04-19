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
