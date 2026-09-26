import { lstatSync, realpathSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

export const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
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
  const root = realpathSync(resolve(filesRoot));
  const resolved = resolve(inputPath);
  const metadata = lstatSync(resolved);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('path must be a regular file, not a symlink or directory');
  }
  const real = realpathSync(resolved);
  if (real === root || !real.startsWith(`${root}${sep}`)) {
    throw new Error('path must stay under the workspace files directory');
  }
  const size = statSync(real).size;
  if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
    throw new Error(`file exceeds Telegram upload limit of ${TELEGRAM_MAX_UPLOAD_BYTES} bytes`);
  }
  return {
    path: real,
    size,
    sentAs: TELEGRAM_IMAGE_EXTENSIONS.has(extname(real).toLowerCase()) ? 'photo' : 'document',
  };
}
