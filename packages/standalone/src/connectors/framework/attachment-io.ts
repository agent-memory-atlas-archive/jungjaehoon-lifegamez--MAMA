import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/** Resolve the actual destination before a daemon writes an owner attachment. */
export function resolveAttachmentDirectory(workspace: string, directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const workspacePath = realpathSync(workspace);
  const directoryPath = realpathSync(directory);
  const local = relative(workspacePath, directoryPath);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error('Attachment directory is outside the owner workspace');
  }
  return directoryPath;
}

export function requireHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is missing`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must use https`);
  return parsed.href;
}

// Cap connector downloads at 50 MiB (52,428,800 bytes), based on Bot API document delivery.
const ATTACHMENT_DOWNLOAD_LIMIT = 50 * 1024 * 1024;

/** Validate and open without yielding to an agent that can replace workspace directories. */
export function saveAttachmentBytes(
  workspace: string,
  targetPath: string,
  bytes: Uint8Array
): void {
  const directory = resolveAttachmentDirectory(workspace, dirname(targetPath));
  const finalPath = join(directory, basename(targetPath));
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.part`;
  const fd = openSync(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    writeFileSync(fd, bytes);
  } catch (error) {
    closeSync(fd);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(fd);
  // rename replaces the final name itself (a symlink placed there is replaced, never followed).
  renameSync(temporaryPath, finalPath);
}

export async function saveResponseBody(
  response: Response,
  targetPath: string,
  workspace: string
): Promise<number> {
  if (!response.body) throw new Error('attachment download response has no body');
  const limitError = new Error('attachment download exceeds the 50 MiB (52428800 bytes) limit');
  if (Number(response.headers.get('content-length')) > ATTACHMENT_DOWNLOAD_LIMIT) {
    // Cleanup failures must not replace the safe size-limit error with transport details.
    await response.body.cancel().catch(() => undefined);
    throw limitError;
  }
  let size = 0;
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > ATTACHMENT_DOWNLOAD_LIMIT) throw limitError;
      chunks.push(chunk);
    }
    saveAttachmentBytes(workspace, targetPath, Buffer.concat(chunks));
    return size;
  } catch (error) {
    if (error === limitError) throw error;
    // Transport and filesystem errors can contain authenticated URLs or local paths.
    throw new Error('attachment download failed while saving body');
  }
}
