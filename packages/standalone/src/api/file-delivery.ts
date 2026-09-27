import { closeSync, constants, fstatSync, lstatSync, openSync, read, realpathSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export interface TelegramFileDeliveryResult {
  messageId?: number;
  sentAs: 'photo' | 'document';
  size: number;
  idempotent?: boolean;
}

export interface TelegramFileSender {
  sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<TelegramFileDeliveryResult>;
}

export interface ValidatedWorkspaceFile {
  path: string;
  size: number;
  sentAs: 'photo' | 'document';
}

export function validateWorkspaceFile(
  filesRoot: string,
  inputPath: string
): ValidatedWorkspaceFile {
  const { fd, ...validated } = openWorkspaceFile(filesRoot, inputPath);
  closeSync(fd);
  return validated;
}

/** Keep this descriptor open through upload so a later path replacement cannot change its bytes. */
export function openWorkspaceFile(
  filesRoot: string,
  inputPath: string
): ValidatedWorkspaceFile & { fd: number } {
  const rootPath = resolve(filesRoot);
  const rootMetadata = lstatSync(rootPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('workspace files root must be a directory, not a symlink');
  }
  const root = realpathSync(rootPath);
  if (root !== join(realpathSync(dirname(rootPath)), basename(rootPath))) {
    throw new Error('workspace files root must resolve to its own directory');
  }
  const resolved = resolve(inputPath);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('path must be a regular file, not a symlink or directory');
  }
  const real = realpathSync(resolved);
  if (real === root || !real.startsWith(`${root}${sep}`)) {
    throw new Error('path must stay under the workspace files directory');
  }
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('path must be a regular file');
    const size = opened.size;
    if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
      throw new Error(`file exceeds Telegram upload limit of ${TELEGRAM_MAX_UPLOAD_BYTES} bytes`);
    }
    return {
      fd,
      path: real,
      size,
      sentAs:
        size <= TELEGRAM_MAX_PHOTO_BYTES &&
        TELEGRAM_IMAGE_EXTENSIONS.has(extname(real).toLowerCase())
          ? 'photo'
          : 'document',
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Read the validated descriptor without reopening its mutable pathname. The caller closes it. */
export async function* readWorkspaceFile(fd: number): AsyncGenerator<Buffer> {
  while (true) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = await new Promise<number>((resolve, reject) => {
      read(fd, buffer, 0, buffer.length, null, (error, size) =>
        error ? reject(error) : resolve(size)
      );
    });
    if (bytesRead === 0) return;
    yield buffer.subarray(0, bytesRead);
  }
}
