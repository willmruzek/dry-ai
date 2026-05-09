import path from 'node:path';

import { SystemError, type PlatformError } from '@effect/platform/Error';
import { FileSystem } from '@effect/platform/FileSystem';
import { Data, Effect } from 'effect';

function platformErrorLine(error: PlatformError): string {
  if (error._tag === 'SystemError' || error._tag === 'BadArgument') {
    return error.message;
  }
  return String(error);
}

/** Sync: create a directory before writing generated output. */
export class EnsureDirError extends Data.TaggedError('EnsureDirError')<{
  readonly directoryPath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Creating directory ${this.directoryPath}: ${platformErrorLine(this.cause)}`;
  }
}

/** Sync: read a UTF-8 file from the config tree or manifest path. */
export class ReadFileError extends Data.TaggedError('ReadFileError')<{
  readonly filePath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Reading file ${this.filePath}: ${platformErrorLine(this.cause)}`;
  }
}

/** Sync: write a UTF-8 file (e.g. manifest or rendered artifact). */
export class WriteFileError extends Data.TaggedError('WriteFileError')<{
  readonly filePath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Writing file ${this.filePath}: ${platformErrorLine(this.cause)}`;
  }
}

/** Sync: remove a path (file or directory tree). */
export class RemovePathError extends Data.TaggedError('RemovePathError')<{
  readonly targetPath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Removing path ${this.targetPath}: ${platformErrorLine(this.cause)}`;
  }
}

/** Sync: empty a directory and recreate it before copying skill trees. */
export class EmptyDirError extends Data.TaggedError('EmptyDirError')<{
  readonly directoryPath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Emptying and preparing directory ${this.directoryPath}: ${platformErrorLine(this.cause)}`;
  }
}

/** Skills / sync: metadata existence probe via Effect FileSystem. */
export class PathExistsCheckError extends Data.TaggedError(
  'PathExistsCheckError',
)<{
  readonly filePath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Checking path exists ${this.filePath}: ${platformErrorLine(this.cause)}`;
  }
}

/** `FileSystem.readDirectory` failed for the given path. */
export class ReadDirectoryError extends Data.TaggedError('ReadDirectoryError')<{
  readonly directoryPath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Reading directory ${this.directoryPath}: ${platformErrorLine(this.cause)}`;
  }
}

/** `FileSystem.copy` failed for one source/target pair (e.g. one entry in a tree copy). */
export class CopyDirectoryEntryError extends Data.TaggedError(
  'CopyDirectoryEntryError',
)<{
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly cause: PlatformError;
}> {
  override get message(): string {
    return `Copying ${this.sourcePath} → ${this.targetPath}: ${platformErrorLine(this.cause)}`;
  }
}

/** `copyDirectoryContents` (empty target, list source, copy each entry). */
export type CopyDirectoryContentsError =
  | EmptyDirError
  | ReadDirectoryError
  | CopyDirectoryEntryError;

export function ensureDirectory(
  directoryPath: string,
): Effect.Effect<void, EnsureDirError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(directoryPath, { recursive: true });
  }).pipe(
    Effect.mapError((cause) => new EnsureDirError({ directoryPath, cause })),
  );
}

export function readFileUtf8(
  filePath: string,
): Effect.Effect<string, ReadFileError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* fs.readFileString(filePath);
  }).pipe(Effect.mapError((cause) => new ReadFileError({ filePath, cause })));
}

export function writeTextFile(
  filePath: string,
  content: string,
): Effect.Effect<void, WriteFileError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFile(filePath, new TextEncoder().encode(content));
  }).pipe(Effect.mapError((cause) => new WriteFileError({ filePath, cause })));
}

export function removePath(
  targetPath: string,
): Effect.Effect<void, RemovePathError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.remove(targetPath, { recursive: true, force: true });
  }).pipe(
    Effect.mapError((cause: PlatformError): RemovePathError => {
      return new RemovePathError({ targetPath, cause });
    }),
  );
}

/**
 * Clears a directory’s contents and ensures the directory exists (like `fs-extra.emptyDir`).
 */
export function emptyDirectory(
  directoryPath: string,
): Effect.Effect<void, EmptyDirError, FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem;
    yield* fs.remove(directoryPath, { recursive: true, force: true }).pipe(
      Effect.catchIf(
        (error): error is SystemError =>
          error instanceof SystemError && error.reason === 'NotFound',
        () => Effect.void,
      ),
    );
    yield* fs.makeDirectory(directoryPath, { recursive: true });
  }).pipe(
    Effect.mapError((cause) => new EmptyDirError({ directoryPath, cause })),
  );
}

/**
 * Clears targetDir and copies all direct entries from sourceDir into it.
 *
 * Requires {@link FileSystem} (provide `env.runtime.fileSystemLayer` at the command root).
 */
export function copyDirectoryContents(
  sourceDir: string,
  targetDir: string,
): Effect.Effect<void, CopyDirectoryContentsError, FileSystem> {
  return Effect.gen(function* () {
    yield* emptyDirectory(targetDir);

    const fs = yield* FileSystem;
    const entryNames = yield* fs
      .readDirectory(sourceDir)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ReadDirectoryError({ directoryPath: sourceDir, cause }),
        ),
      );

    for (const entryName of entryNames) {
      const from = path.join(sourceDir, entryName);
      const to = path.join(targetDir, entryName);
      yield* fs.copy(from, to).pipe(
        Effect.mapError(
          (cause) =>
            new CopyDirectoryEntryError({
              sourcePath: from,
              targetPath: to,
              cause,
            }),
        ),
      );
    }
  });
}
