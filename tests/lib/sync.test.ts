import path from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

import {
  ensureDirectory,
  readFileUtf8,
  writeTextFile,
  EnsureDirError,
  ReadFileError,
  WriteFileError,
} from '../../src/lib/fs.js';

import {
  createMockFileSystemState,
  mockFailMakeDirectory,
  mockFailReadFileString,
  mockFailWriteFile,
  mockFileSystemLayer,
  mockPathExists,
  normalizeMockPath,
  readMockTextFile,
  storeMockTextFile,
} from '../helpers.js';

describe('ensureDirectory', () => {
  it.effect('creates the directory when makeDirectory succeeds', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const directoryPath = normalizeMockPath('/virtual/sync-unit/out');

      const exit = yield* ensureDirectory(directoryPath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      expect(Exit.isSuccess(exit)).toBe(true);

      expect(mockPathExists({ handle, targetPath: directoryPath })).toBe(true);
    }),
  );

  it.effect('maps FileSystem failures to EnsureDirError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const directoryPath = normalizeMockPath('/virtual/sync-unit/blocked');

      mockFailMakeDirectory({
        handle,
        absolutePath: directoryPath,
        message: 'disk full',
      });

      const exit = yield* ensureDirectory(directoryPath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        const error = failureOpt.value;
        expect(error).toBeInstanceOf(EnsureDirError);
        expect(error._tag).toBe('EnsureDirError');

        expect(error.directoryPath).toBe(directoryPath);
        expect(error.cause._tag).toBe('SystemError');

        expect(error.cause.message).toContain('disk full');
      }
    }),
  );
});

describe('readFileUtf8', () => {
  it.effect('returns file contents when readFileString succeeds', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath('/virtual/sync-unit/read/hello.txt');
      const body = 'hello world';

      storeMockTextFile({
        handle,
        filePath,
        content: body,
      });

      const exit = yield* readFileUtf8(filePath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) {
        expect(exit.value).toBe(body);
      }
    }),
  );

  it.effect('maps explicit mock read failures to ReadFileError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath('/virtual/sync-unit/read/blocked.txt');

      mockFailReadFileString({
        handle,
        absolutePath: filePath,
        message: 'permission denied',
      });

      const exit = yield* readFileUtf8(filePath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        const error = failureOpt.value;
        expect(error).toBeInstanceOf(ReadFileError);
        expect(error._tag).toBe('ReadFileError');

        expect(error.filePath).toBe(filePath);
        expect(error.cause._tag).toBe('SystemError');

        expect(error.cause.message).toContain('permission denied');
      }
    }),
  );

  it.effect('maps missing-file SystemError to ReadFileError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath('/virtual/sync-unit/read/missing.txt');

      const exit = yield* readFileUtf8(filePath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        const error = failureOpt.value;
        expect(error).toBeInstanceOf(ReadFileError);
        expect(error._tag).toBe('ReadFileError');

        expect(error.filePath).toBe(filePath);
        expect(error.cause._tag).toBe('SystemError');

        expect(error.cause.message).toContain('missing.txt');
      }
    }),
  );
});

describe('writeTextFile', () => {
  it.effect('writes UTF-8 content and creates parent directories', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath(
        '/virtual/sync-unit/write/nested/out.txt',
      );
      const content = 'manifest body';

      const exit = yield* writeTextFile(filePath, content).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      expect(Exit.isSuccess(exit)).toBe(true);

      expect(readMockTextFile({ handle, filePath })).toBe(content);
    }),
  );

  it.effect('maps mock writeFile failures to WriteFileError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath(
        '/virtual/sync-unit/write/blocked.txt',
      );

      mockFailWriteFile({
        handle,
        absolutePath: filePath,
        message: 'read-only filesystem',
      });

      const exit = yield* writeTextFile(filePath, 'x').pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        const error = failureOpt.value;
        expect(error).toBeInstanceOf(WriteFileError);
        expect(error._tag).toBe('WriteFileError');

        expect(error.filePath).toBe(filePath);
        expect(error.cause._tag).toBe('SystemError');

        expect(error.cause.message).toContain('read-only filesystem');
      }
    }),
  );

  it.effect('maps makeDirectory failures to WriteFileError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath(
        '/virtual/sync-unit/write/no-parent/file.txt',
      );
      const parentDir = normalizeMockPath(path.dirname(filePath));

      mockFailMakeDirectory({
        handle,
        absolutePath: parentDir,
        message: 'quota exceeded',
      });

      const exit = yield* writeTextFile(filePath, 'y').pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        const error = failureOpt.value;
        expect(error).toBeInstanceOf(WriteFileError);
        expect(error._tag).toBe('WriteFileError');

        expect(error.filePath).toBe(filePath);
        expect(error.cause._tag).toBe('SystemError');

        expect(error.cause.message).toContain('quota exceeded');
      }
    }),
  );
});
