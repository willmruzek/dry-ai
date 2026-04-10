import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';

describe('Calculator', () => {
  // Sync test - regular function
  it('creates instances', () => {
    const result = 1 + 1;
    expect(result).toBe(2);
  });

  // Effect test - returns Effect
  it.effect('adds numbers', () =>
    Effect.gen(function* () {
      const result = yield* Effect.succeed(1 + 1);
      expect(result).toBe(2);
    }),
  );
});
