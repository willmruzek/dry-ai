import path from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import * as Cause from 'effect/Cause';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';

import {
  copyDirectoryContents,
  CopyDirectoryEntryError,
  emptyDirectory,
  EmptyDirError,
  EnsureDirError,
  ReadDirectoryError,
  ReadFileError,
  RemovePathError,
  removePath,
  writeTextFile,
  WriteFileError,
  ensureDirectory,
  readFileUtf8,
} from '../../src/lib/fs.js';

import {
  createMockFileSystemState,
  ensureMockDirectory,
  mockFailCopyDest,
  mockFailMakeDirectory,
  mockFailReadFileString,
  mockFailRemove,
  mockFailWriteFile,
  mockFileSystemLayer,
  mockPathExists,
  normalizeMockPath,
  readMockTextFile,
  storeMockTextFile,
} from '../helpers.ts';

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
        expect(error.message).toContain('disk full');
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
        expect(error.message).toContain('permission denied');
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
        expect(error.message).toContain('missing.txt');
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
        expect(error.message).toContain('read-only filesystem');
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
        expect(error.message).toContain('quota exceeded');
      }
    }),
  );
});

describe('removePath', () => {
  it.effect('removes an existing file', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const filePath = normalizeMockPath('/virtual/fs-unit/remove/me.txt');
      storeMockTextFile({ handle, filePath, content: 'bye' });

      const exit = yield* removePath(filePath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(mockPathExists({ handle, targetPath: filePath })).toBe(false);
    }),
  );

  it.effect('maps remove failures to RemovePathError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const targetPath = normalizeMockPath('/virtual/fs-unit/remove/ghost');

      mockFailRemove({
        handle,
        absolutePath: targetPath,
        message: 'cannot delete',
      });

      const result = yield* removePath(targetPath).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.either,
      );

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        const error = result.left;
        expect(error).toBeInstanceOf(RemovePathError);
        expect(error._tag).toBe('RemovePathError');
        expect(error.targetPath).toBe(targetPath);
        expect(error.message).toContain('cannot delete');
      }
    }),
  );
});

describe('emptyDirectory', () => {
  it.effect(
    'creates the directory when it did not exist (remove NotFound ignored)',
    () =>
      Effect.gen(function* () {
        const handle = createMockFileSystemState();
        const dir = normalizeMockPath('/virtual/fs-unit/empty/new-dir');

        const exit = yield* emptyDirectory(dir).pipe(
          Effect.provide(mockFileSystemLayer(handle)),
          Effect.exit,
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(mockPathExists({ handle, targetPath: dir })).toBe(true);
      }),
  );

  it.effect('clears an existing directory and recreates it', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const dir = normalizeMockPath('/virtual/fs-unit/empty/existing');
      ensureMockDirectory({ handle, directoryPath: dir });
      storeMockTextFile({
        handle,
        filePath: path.join(dir, 'old.txt'),
        content: 'stale',
      });

      const exit = yield* emptyDirectory(dir).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(mockPathExists({ handle, targetPath: dir })).toBe(true);
      expect(
        mockPathExists({
          handle,
          targetPath: path.join(dir, 'old.txt'),
        }),
      ).toBe(false);
    }),
  );

  it.effect('maps non-NotFound remove failures to EmptyDirError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const dir = normalizeMockPath('/virtual/fs-unit/empty/remove-fail');
      ensureMockDirectory({ handle, directoryPath: dir });

      mockFailRemove({
        handle,
        absolutePath: dir,
        message: 'busy',
      });

      const exit = yield* emptyDirectory(dir).pipe(
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
        expect(error).toBeInstanceOf(EmptyDirError);
        expect(error.message).toContain('busy');
      }
    }),
  );

  it.effect('maps makeDirectory failures to EmptyDirError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const dir = normalizeMockPath('/virtual/fs-unit/empty/mkdir-fail');

      mockFailMakeDirectory({
        handle,
        absolutePath: dir,
        message: 'no space',
      });

      const exit = yield* emptyDirectory(dir).pipe(
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
        expect(error).toBeInstanceOf(EmptyDirError);
        expect(error.message).toContain('no space');
      }
    }),
  );
});

describe('copyDirectoryContents', () => {
  it.effect('copies direct children from source into target', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const src = normalizeMockPath('/virtual/fs-unit/copy/src');
      const dst = normalizeMockPath('/virtual/fs-unit/copy/dst');
      ensureMockDirectory({ handle, directoryPath: src });
      storeMockTextFile({
        handle,
        filePath: path.join(src, 'note.txt'),
        content: 'copied',
      });

      const exit = yield* copyDirectoryContents(src, dst).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        readMockTextFile({ handle, filePath: path.join(dst, 'note.txt') }),
      ).toBe('copied');
    }),
  );

  it.effect('maps readDirectory failures to ReadDirectoryError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const src = normalizeMockPath('/virtual/fs-unit/copy/missing-src');
      const dst = normalizeMockPath('/virtual/fs-unit/copy/dst2');

      const exit = yield* copyDirectoryContents(src, dst).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        const err = failureOpt.value;
        expect(err).toBeInstanceOf(ReadDirectoryError);
        if (err instanceof ReadDirectoryError) {
          expect(err.directoryPath).toBe(src);
        }
      }
    }),
  );

  it.effect('maps copy failures to CopyDirectoryEntryError', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const src = normalizeMockPath('/virtual/fs-unit/copy/src3');
      const dst = normalizeMockPath('/virtual/fs-unit/copy/dst3');
      ensureMockDirectory({ handle, directoryPath: src });
      storeMockTextFile({
        handle,
        filePath: path.join(src, 'a.txt'),
        content: 'x',
      });

      const destFile = path.join(dst, 'a.txt');
      mockFailCopyDest({
        handle,
        destinationPath: normalizeMockPath(destFile),
        message: 'copy blocked',
      });

      const exit = yield* copyDirectoryContents(src, dst).pipe(
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
        expect(error).toBeInstanceOf(CopyDirectoryEntryError);
        expect(error.message).toContain('copy blocked');
      }
    }),
  );

  it.effect('propagates EmptyDirError when emptyDirectory fails', () =>
    Effect.gen(function* () {
      const handle = createMockFileSystemState();
      const src = normalizeMockPath('/virtual/fs-unit/copy/src4');
      const dst = normalizeMockPath('/virtual/fs-unit/copy/dst4');
      ensureMockDirectory({ handle, directoryPath: src });
      storeMockTextFile({
        handle,
        filePath: path.join(src, 'x.txt'),
        content: 'x',
      });
      ensureMockDirectory({ handle, directoryPath: dst });

      mockFailRemove({
        handle,
        absolutePath: dst,
        message: 'target locked',
      });

      const exit = yield* copyDirectoryContents(src, dst).pipe(
        Effect.provide(mockFileSystemLayer(handle)),
        Effect.exit,
      );

      if (!Exit.isFailure(exit)) {
        throw new Error('expected Exit.failure');
      }

      const failureOpt = Cause.failureOption(exit.cause);
      expect(Option.isSome(failureOpt)).toBe(true);
      if (Option.isSome(failureOpt)) {
        expect(failureOpt.value).toBeInstanceOf(EmptyDirError);
        expect(failureOpt.value.message).toContain('target locked');
      }
    }),
  );
});
