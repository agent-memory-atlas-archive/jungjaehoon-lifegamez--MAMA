import { createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
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

export async function saveResponseBody(response: Response, targetPath: string): Promise<number> {
  if (!response.body) throw new Error('attachment download response has no body');
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.part`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      createWriteStream(temporaryPath)
    );
    renameSync(temporaryPath, targetPath);
    return statSync(targetPath).size;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
