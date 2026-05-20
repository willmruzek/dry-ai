import { InvalidArgumentError } from 'commander';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';

import {
  parseOptionsObject,
  parseOptionValue,
  RootOptionsSchema,
} from '../../src/lib/command-options.js';
import { NonEmptyTrimmedString } from '../../src/lib/schemas.js';

const optionsLabel = 'test options';

/** Minimal fixtures — only to trigger failures through our parsers. */
const invalidPathObject = Schema.Struct({
  path: Schema.String.pipe(
    Schema.minLength(1, { message: () => 'must not be empty' }),
  ),
});

const nestedInvalidPathObject = Schema.Struct({
  outer: Schema.Struct({
    inner: Schema.String.pipe(
      Schema.minLength(1, { message: () => 'must not be empty' }),
    ),
  }),
});

const multiFieldInvalidObject = Schema.Struct({
  first: Schema.String.pipe(
    Schema.minLength(1, { message: () => 'first invalid' }),
  ),
  second: Schema.String.pipe(
    Schema.minLength(1, { message: () => 'second invalid' }),
  ),
});

const arrayInvalidObject = Schema.Struct({
  skill: Schema.Array(
    Schema.String.pipe(
      Schema.minLength(1, { message: () => 'must not be empty' }),
    ),
  ),
});

describe('command-options', () => {
  describe('parseOptionsObject', () => {
    it('returns the schema output when validation succeeds', () => {
      // Arrange
      const schema = Schema.Struct({ force: Schema.Boolean });
      const options = { force: true };

      // Act
      const parsed = parseOptionsObject({
        schema,
        options,
        optionsLabel: optionsLabel,
      });

      // Assert
      expect(parsed).toEqual({ force: true });
    });

    it('parses exported root options through the wrapper', () => {
      // Arrange
      const options = { test: true, debug: true };
      const expected = {
        test: true,
        debug: true,
        configRoot: undefined,
        outputRoot: undefined,
      };

      // Act
      const parsed = parseOptionsObject({
        schema: RootOptionsSchema,
        options,
        optionsLabel: 'root options',
      });

      // Assert
      expect(parsed).toEqual(expected);
    });

    it('throws InvalidArgumentError when validation fails', () => {
      // Act
      const act = () =>
        parseOptionsObject({
          schema: invalidPathObject,
          options: { path: '' },
          optionsLabel: optionsLabel,
        });

      // Assert
      expect(act).toThrow(InvalidArgumentError);
    });

    it('prefixes validation errors with the options label', () => {
      // Arrange
      const label = 'skills import options';

      // Act
      const act = () =>
        parseOptionsObject({
          schema: invalidPathObject,
          options: { path: '' },
          optionsLabel: label,
        });

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(new RegExp(`^${label}: path:`));
    });

    it('includes dotted paths for nested field errors', () => {
      // Act
      const act = () =>
        parseOptionsObject({
          schema: nestedInvalidPathObject,
          options: { outer: { inner: '' } },
          optionsLabel: optionsLabel,
        });

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(
        new RegExp(`${optionsLabel}: outer\\.inner: must not be empty`),
      );
    });

    it('joins multiple field errors with "; "', () => {
      // Act
      const act = () =>
        parseOptionsObject({
          schema: multiFieldInvalidObject,
          options: { first: '', second: '' },
          optionsLabel: optionsLabel,
        });

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(/first: first invalid/);
      expect(act).toThrow(/second: second invalid/);
      expect(act).toThrow(/; /);
    });

    it('prefixes failures when options is not an object', () => {
      // Act
      const act = () =>
        parseOptionsObject({
          schema: Schema.Struct({ force: Schema.Boolean }),
          options: null,
          optionsLabel: optionsLabel,
        });

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(new RegExp(`^${optionsLabel}:`));
    });

    it('includes array indices in issue paths', () => {
      // Act
      const act = () =>
        parseOptionsObject({
          schema: arrayInvalidObject,
          options: { skill: ['ok', ''] },
          optionsLabel: optionsLabel,
        });

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(
        new RegExp(`${optionsLabel}: skill\\.1: must not be empty`),
      );
    });
  });

  describe('parseOptionValue', () => {
    const optionLabel = '--path';

    const invalidString = Schema.String.pipe(
      Schema.minLength(1, { message: () => 'must not be empty' }),
    );

    const compositeString = Schema.String.pipe(
      Schema.minLength(3, { message: () => 'too short' }),
      Schema.pattern(/^[a-z]+$/, { message: () => 'lowercase letters only' }),
    );

    it('returns a parser function that yields the schema output', () => {
      // Arrange
      const parse = parseOptionValue({
        schema: invalidString,
        optionLabel,
      });

      // Act
      const parsed = parse('alpha');

      // Assert
      expect(parsed).toBe('alpha');
    });

    it('throws InvalidArgumentError when validation fails', () => {
      // Arrange
      const parse = parseOptionValue({
        schema: invalidString,
        optionLabel,
      });

      // Act
      const act = () => parse('');

      // Assert
      expect(act).toThrow(InvalidArgumentError);
    });

    it('prefixes validation errors with the option label', () => {
      // Arrange
      const label = '--config-root';
      const parse = parseOptionValue({
        schema: invalidString,
        optionLabel: label,
      });

      // Act
      const act = () => parse('');

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(new RegExp(`^${label}:`));
    });

    it('joins multiple validation issues with "; " for one value', () => {
      // Arrange
      const label = '--name';
      const parse = parseOptionValue({
        schema: compositeString,
        optionLabel: label,
      });

      // Act
      const act = () => parse('1');

      // Assert
      expect(act).toThrow(InvalidArgumentError);
      expect(act).toThrow(new RegExp(`^${label}:`));
      expect(act).toThrow(/too short/);
    });

    it('parses exported non-empty option strings through the wrapper', () => {
      // Arrange
      const parse = parseOptionValue({
        schema: NonEmptyTrimmedString,
        optionLabel,
      });
      const raw = '  skills/  ';

      // Act
      const parsed = parse(raw);

      // Assert
      expect(parsed).toBe('skills/');
    });
  });
});
