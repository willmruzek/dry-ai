import path from 'node:path';

import { SystemError } from '@effect/platform/Error';
import * as Cause from 'effect/Cause';
import * as Chunk from 'effect/Chunk';

import {
  CopyDirectoryEntryError,
  EmptyDirError,
  EnsureDirError,
  PathExistsCheckError,
  ReadDirectoryError,
  ReadFileError,
  RemovePathError,
  WriteFileError,
} from '../lib/fs.js';
import {
  InvalidSkillsLockfile,
  ManagedSkillNotFoundError,
  RemoteSkillDirectoryInvalid,
} from '../lib/skills.js';
import {
  EnsureSkillsSourceRootError,
  GitCheckoutTempDirectoryError,
  ListSkillSubdirectoriesError,
  RemoveManagedSkillDirectoryError,
  ReplaceManagedSkillOutputError,
  RemoteSkillValidationFsError,
  SkillContentHashReadError,
  SkillDirectoryWalkError,
  SkillsLockfileEncodeError,
  SkillsLockfileExistsCheckError,
  SkillsLockfileReadContentsError,
  SkillsLockfileWriteError,
  SyncStatPathError,
} from '../lib/sync.js';

/** Prefer simulation/diagnostic text carried on {@link SystemError#description}. */
function cliMessageFromPlatformCause(cause: unknown): string | undefined {
  if (
    cause instanceof SystemError &&
    typeof cause.description === 'string' &&
    cause.description.length > 0
  ) {
    return cause.description;
  }
  return undefined;
}

/**
 * CLI-facing copy for a domain failure. Uses structured fields only — not
 * {@link Error#message} on tagged errors (that string stays diagnostic).
 */
export function formatCliUserMessage(error: unknown): string {
  if (error instanceof EnsureDirError) {
    return `Could not create directory: ${error.directoryPath}`;
  }
  if (error instanceof ReadFileError) {
    return `Could not read file: ${error.filePath}`;
  }
  if (error instanceof WriteFileError) {
    return `Could not write file: ${error.filePath}`;
  }
  if (error instanceof RemovePathError) {
    const detail = cliMessageFromPlatformCause(error.cause);
    if (detail !== undefined) {
      return detail;
    }
    return `Could not remove path: ${error.targetPath}`;
  }
  if (error instanceof EmptyDirError) {
    const detail = cliMessageFromPlatformCause(error.cause);
    if (detail !== undefined) {
      return detail;
    }
    return `Could not prepare directory: ${error.directoryPath}`;
  }
  if (error instanceof PathExistsCheckError) {
    return `Could not check whether path exists: ${error.filePath}`;
  }
  if (error instanceof ReadDirectoryError) {
    return `Could not read directory: ${error.directoryPath}`;
  }
  if (error instanceof CopyDirectoryEntryError) {
    const detail = cliMessageFromPlatformCause(error.cause);
    if (detail !== undefined) {
      return detail;
    }
    return `Could not copy into the sync output (${error.targetPath}).`;
  }
  if (error instanceof EnsureSkillsSourceRootError) {
    return `Could not create the skills directory: ${error.skillsRoot}`;
  }
  if (error instanceof SkillsLockfileExistsCheckError) {
    return `Could not check the skills lockfile: ${error.lockfilePath}`;
  }
  if (error instanceof SkillsLockfileReadContentsError) {
    return `Could not read the skills lockfile: ${error.lockfilePath}`;
  }
  if (error instanceof SkillsLockfileEncodeError) {
    return `Could not serialize the skills lockfile: ${error.lockfilePath}`;
  }
  if (error instanceof SkillsLockfileWriteError) {
    return `Could not write the skills lockfile: ${error.lockfilePath}`;
  }
  if (error instanceof ListSkillSubdirectoriesError) {
    return `Could not list skill folders under: ${error.skillsRoot}`;
  }
  if (error instanceof GitCheckoutTempDirectoryError) {
    return `Could not create a temporary directory for cloning (prefix ${error.tempPrefix}).`;
  }
  if (error instanceof ReplaceManagedSkillOutputError) {
    const detail = cliMessageFromPlatformCause(error.cause);
    if (detail !== undefined) {
      return detail;
    }
    return `Could not install skill files into: ${error.targetDir}`;
  }
  if (error instanceof RemoveManagedSkillDirectoryError) {
    return `Could not remove skill directory: ${error.directoryPath}`;
  }
  if (error instanceof SkillDirectoryWalkError) {
    return `Could not scan skill directory: ${error.directoryPath}`;
  }
  if (error instanceof SkillContentHashReadError) {
    return `Could not read file while hashing skill content: ${path.join(error.directoryPath, error.relativePath)}`;
  }
  if (error instanceof RemoteSkillValidationFsError) {
    return `Could not validate imported skill files at: ${error.sourceDir}`;
  }
  if (error instanceof SyncStatPathError) {
    return `Could not inspect path while syncing: ${error.path}`;
  }
  if (error instanceof InvalidSkillsLockfile) {
    return `Could not parse the skills lockfile (${error.lockfilePath}). Fix JSON/schema errors in that file.`;
  }
  if (error instanceof ManagedSkillNotFoundError) {
    return `No managed skill named "${error.skillName}" is listed in the skills lockfile. Try \`skills list\`.`;
  }
  if (error instanceof RemoteSkillDirectoryInvalid) {
    switch (error.reason) {
      case 'path_missing':
        return `That skill path was not found in the repository: ${error.skillPath}`;
      case 'not_directory':
        return `That skill path is not a directory in the repository: ${error.skillPath}`;
      case 'missing_skill_md':
        return `That skill folder is missing SKILL.md: ${error.skillPath}`;
      default: {
        const _never: never = error.reason;
        return _never;
      }
    }
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Something went wrong.';
}

/** Maps an Effect failure {@link Cause.Cause} to one user-facing line (first failure). */
export function formatCliUserMessageFromCause(
  cause: Cause.Cause<unknown>,
): string {
  const failures = Chunk.toReadonlyArray(Cause.failures(cause));
  if (failures.length > 0) {
    return formatCliUserMessage(failures[0]);
  }
  return formatCliUserMessage(Cause.squash(cause));
}
