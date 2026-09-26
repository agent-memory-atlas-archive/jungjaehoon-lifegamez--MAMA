import { execFile } from 'node:child_process';

export function parseGwsOutput(raw: string): unknown {
  const lines = raw.split('\n');
  const jsonStart = lines.findIndex(
    (line) => line.trimStart().startsWith('{') || line.trimStart().startsWith('[')
  );
  if (jsonStart === -1) throw new Error('No JSON found in gws CLI output');
  const result: unknown = JSON.parse(lines.slice(jsonStart).join('\n'));
  if (result && typeof result === 'object' && 'error' in result) {
    throw new Error(`gws CLI returned an error: ${JSON.stringify(result.error)}`);
  }
  return result;
}

/** Keep upstream page tokens in argv, never in a shell command; do not block the daemon. */
export async function execGwsAsync(
  args: string[],
  options?: { maxBuffer?: number }
): Promise<unknown> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'gws',
      args,
      { encoding: 'utf8', maxBuffer: options?.maxBuffer, timeout: 60_000 },
      (error, value) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      }
    );
  });
  return parseGwsOutput(stdout);
}
