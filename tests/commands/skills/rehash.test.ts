import { describe, it } from 'vitest';

describe('dry-ai skills rehash', () => {
  describe('happy paths', () => {
    describe('basic rehash', () => {
      // priority: high
      it.todo(
        'recomputes file hashes from the local skill directory and updates the lockfile entry',
      );

      // priority: med
      it.todo(
        "sets the lockfile entry's updatedAt to the current timestamp after rehashing",
      );

      // priority: med
      it.todo(
        'leaves the commit/ref/repo/importedAt fields of the lockfile entry unchanged after rehashing',
      );

      // priority: med
      it.todo('leaves other managed skill entries in the lockfile untouched');

      // priority: med
      it.todo(
        'prints the rehashed skill summary ("Rehashed <summary>") to stdout',
      );

      // priority: low
      it.todo('keeps stderr empty on a successful rehash');
    });

    describe('file hash semantics', () => {
      // priority: high
      it.todo(
        'detects newly added files in the local directory and adds them to the lockfile hashes',
      );

      // priority: high
      it.todo(
        'detects removed files in the local directory and drops them from the lockfile hashes',
      );

      // priority: high
      it.todo(
        'detects content changes and updates the corresponding SHA-256 hashes',
      );

      // priority: low
      it.todo(
        'still saves the lockfile and bumps updatedAt when no files have changed since the previous hash',
      );

      // priority: low
      it.todo(
        'records an empty files map when the local skill directory contains no files',
      );
    });
  });

  describe('sad paths', () => {
    // priority: low
    it.todo(
      'rejects "dry-ai skills rehash" without a <name> positional argument with a commander.missingArgument error',
    );

    // priority: low
    it.todo(
      'rejects "dry-ai skills rehash" invoked with an unknown flag (e.g. --bogus) with a commander.unknownOption error',
    );

    // priority: med
    it.todo('throws when the skill name is not present in the lockfile');

    // priority: med
    it.todo(
      'throws when the managed skill directory is missing from disk, with a message containing the expected path',
    );

    // priority: low
    it.todo(
      'throws the "Invalid skills lockfile" error when the existing lockfile fails schema validation (version mismatch, duplicate skill name, or malformed entries)',
    );
  });
});
