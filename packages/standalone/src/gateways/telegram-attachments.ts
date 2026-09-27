import { join } from 'node:path';
import type { Bot, Context } from 'grammy';
import { safeFileName } from '../api/attachment-actions.js';
import { saveAttachmentBytes } from '../connectors/framework/attachment-io.js';

type TelegramMessage = NonNullable<Context['message']>;
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const LIMIT_ERROR = 'Telegram Bot API download limit is 20 MB';

export type OwnerAttachment =
  | { path: string; name: string; mimeType?: string; size: number }
  | { name: string; error: string };

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}

const MEDIA_MIME_TYPES = {
  document: 'application/octet-stream',
  video: 'video/mp4',
  animation: 'video/mp4',
  audio: 'audio/mpeg',
  voice: 'audio/ogg',
  video_note: 'video/mp4',
} as const;

function extension(mimeType: string): string {
  const known: Record<string, string> = {
    'application/octet-stream': 'bin',
    'application/x-tgsticker': 'tgs',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'video/quicktime': 'mov',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel': 'xls',
  };
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  return known[mime] ?? mime.slice(mime.indexOf('/') + 1);
}

export function telegramFiles(
  message: TelegramMessage
): Array<{ file: TelegramFile; name: string; mimeType: string }> {
  const files: Array<{ file: TelegramFile; name: string; mimeType: string }> = [];
  if (message.photo?.length) {
    const photo = message.photo.reduce((largest, current) =>
      current.width * current.height > largest.width * largest.height ? current : largest
    );
    files.push({ file: photo, name: `photo_${photo.file_unique_id}.jpg`, mimeType: 'image/jpeg' });
  }
  for (const kind of Object.keys(MEDIA_MIME_TYPES) as Array<keyof typeof MEDIA_MIME_TYPES>) {
    if (kind === 'document' && message.animation) continue;
    const file: TelegramFile | undefined = message[kind];
    if (!file) continue;
    const mimeType = file.mime_type ?? MEDIA_MIME_TYPES[kind];
    files.push({
      file,
      name: file.file_name ?? `${kind}_${file.file_unique_id}.${extension(mimeType)}`,
      mimeType,
    });
  }
  if (message.sticker) {
    const file = message.sticker;
    const mimeType = file.is_video
      ? 'video/webm'
      : file.is_animated
        ? 'application/x-tgsticker'
        : 'image/webp';
    files.push({ file, name: `sticker_${file.file_unique_id}.${extension(mimeType)}`, mimeType });
  }
  return files;
}

/** Download only after the gateway has authenticated the owner and deduplicated the message. */
export async function downloadTelegramFiles(
  files: ReturnType<typeof telegramFiles>,
  options: { api: Bot['api']; token: string; downloadsDir?: string; messageId: number }
): Promise<OwnerAttachment[]> {
  return Promise.all(
    files.map(async ({ file, name: originalName, mimeType }): Promise<OwnerAttachment> => {
      let name = originalName;
      try {
        name = safeFileName(name);
        if ((file.file_size ?? 0) > DOWNLOAD_LIMIT) throw new Error(LIMIT_ERROR);
        if (!options.downloadsDir?.trim())
          throw new Error('Attachment downloads directory is not configured');
        const remote = await options.api.getFile(file.file_id);
        if ((remote.file_size ?? 0) > DOWNLOAD_LIMIT) throw new Error(LIMIT_ERROR);
        if (!remote.file_path) throw new Error('Telegram getFile returned no file path');
        const response = await fetch(
          `https://api.telegram.org/file/bot${options.token}/${remote.file_path}`,
          {
            signal: AbortSignal.timeout(60_000),
          }
        );
        if (!response.ok)
          throw new Error(`Telegram file download failed (HTTP ${response.status})`);
        if (Number(response.headers.get('content-length')) > DOWNLOAD_LIMIT) {
          await response.body?.cancel();
          throw new Error(LIMIT_ERROR);
        }
        if (!response.body) throw new Error('Telegram file download returned no body');
        const chunks: Uint8Array[] = [];
        let size = 0;
        // Bound actual bytes as well as metadata; never leave a truncated file at the input path.
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > DOWNLOAD_LIMIT) throw new Error(LIMIT_ERROR);
          chunks.push(chunk);
        }
        const path = join(options.downloadsDir, 'telegram', `${options.messageId}_${name}`);
        saveAttachmentBytes(path, Buffer.concat(chunks));
        return { path, name, mimeType, size };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          name,
          error: /file is too big/i.test(detail)
            ? LIMIT_ERROR
            : detail.replaceAll(options.token, '[redacted]'),
        };
      }
    })
  );
}
