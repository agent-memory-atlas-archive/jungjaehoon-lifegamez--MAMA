import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

export async function saveResponseBody(response: Response, targetPath: string): Promise<number> {
  if (!response.body) throw new Error('attachment download response has no body');
  const limitError = new Error('attachment download exceeds the 50 MiB (52428800 bytes) limit');
  if (Number(response.headers.get('content-length')) > ATTACHMENT_DOWNLOAD_LIMIT) {
    // Cleanup failures must not replace the safe size-limit error with transport details.
    await response.body.cancel().catch(() => undefined);
    throw limitError;
  }
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
  let size = 0;
  try {
    try {
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.byteLength;
            if (size > ATTACHMENT_DOWNLOAD_LIMIT) callback(limitError);
            else callback(null, chunk);
          },
        }),
        createWriteStream(temporaryPath)
      );
      renameSync(temporaryPath, targetPath);
      return size;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  } catch (error) {
    if (error === limitError) throw error;
    // Transport and filesystem errors can contain authenticated URLs or local paths.
    throw new Error('attachment download failed while saving body');
  }
}
