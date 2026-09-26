import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SecurityEventClass =
  | 'owner_access'
  | 'auth_failed'
  | 'forged_access_header'
  | 'host_rejected'
  | 'probe'
  | 'unknown_identity'
  | 'request_failed';

export interface SecurityEvent {
  time: string;
  class: SecurityEventClass;
  method: string;
  path: string;
  status: number;
  cfRay: string | null;
  country?: string;
  identity: 'token' | 'anonymous' | `access:${string}`;
}

export interface SecurityEventOptions {
  path?: string;
  replay?: boolean;
  sendToOwner?: (text: string, idempotencyKey: string) => Promise<void>;
}

const ALERT_WINDOW_MS = 10 * 60 * 1000;

export function createSecurityEventRecorder(options: SecurityEventOptions = {}) {
  const path = options.path ?? join(homedir(), '.mama', 'logs', 'security-events.jsonl');
  const lastAlert = new Map<string, number>();

  return {
    path,
    record(event: SecurityEvent): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const fd = openSync(path, 'a', 0o600);
        try {
          fchmodSync(fd, 0o600);
          writeFileSync(fd, JSON.stringify(event) + '\n');
        } finally {
          closeSync(fd);
        }
      } catch {
        // Observation failures must not change the response or expose filesystem details.
        console.error('[viewer] security_event_write_failed');
      }

      if (event.class === 'owner_access' || options.replay) return;
      const now = Date.now();
      for (const [key, time] of lastAlert) {
        if (now - time >= ALERT_WINDOW_MS) lastAlert.delete(key);
      }
      const key = `${event.class}:${event.path}`;
      if (lastAlert.has(key)) return;
      // Reserve before the asynchronous send, including failures. There is no retry worker.
      lastAlert.set(key, now);
      const kst = new Date(Date.parse(event.time) + 9 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');
      const text = [
        'Viewer security alert',
        `Class: ${event.class}`,
        `Path: ${event.path}`,
        `Status: ${event.status}`,
        `Time: ${kst} KST`,
        `Country: ${event.country ?? 'unknown'}`,
      ].join('\n');
      void (async () => {
        try {
          if (!options.sendToOwner) throw new Error('Owner alert delivery is unavailable');
          await options.sendToOwner(text, `viewer-security:${randomUUID()}`);
        } catch {
          // Gateway errors can include credentials and destination identifiers.
          console.error('[viewer] security_alert_failed');
        }
      })();
    },
  };
}
