/**
 * ReportStore implementation that survives daemon restarts.
 *
 * Seeds the shared store with saved slots so their original updatedAt and
 * analysis basis survive verbatim. Agent publications commit a whole snapshot
 * synchronously; other store changes are debounced for 250ms.
 *
 * filePath is injection-only: the production path is resolved solely at the
 * daemon runtime call site (api-server-init.ts), never inside this module --
 * createApiServer's default stays the in-memory store so its ~30 test call
 * sites never touch the real ~/.mama (the PR #126 pollution class).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createReportStore, type ReportSlot, type ReportStore } from './report-handler.js';

const WRITE_DEBOUNCE_MS = 250;

// One process-exit hook flushes every store's pending debounced write on a
// graceful stop. Agent publications take the synchronous path below.
const pendingExitFlushes = new Set<() => void>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const flush of pendingExitFlushes) flush();
  });
}

export function createPersistentReportStore(opts: { filePath: string }): ReportStore {
  let snapshot: Record<string, ReportSlot> = {};

  if (existsSync(opts.filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(opts.filePath, 'utf-8')) as Record<string, ReportSlot>;
      snapshot = parsed;
    } catch (err) {
      // fail loud, start empty -- a corrupt snapshot must never take the board down
      console.warn(`[Report] corrupt slot snapshot at ${opts.filePath}, starting empty:`, err);
    }
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let persistedBody = existsSync(opts.filePath) ? JSON.stringify(snapshot) : null;
  const persist = (next: Record<string, ReportSlot>): void => {
    const directory = dirname(opts.filePath);
    mkdirSync(directory, { recursive: true });
    const tempPath = `${opts.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const body = JSON.stringify(next);
    try {
      writeFileSync(tempPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(tempPath, opts.filePath);
      persistedBody = body;
    } finally {
      rmSync(tempPath, { force: true });
    }
  };
  const writeSnapshot = (): void => {
    try {
      persist(snapshot);
    } catch (err) {
      console.warn(`[Report] failed to persist slots to ${opts.filePath}:`, err);
    }
  };

  const flushPending = (): void => {
    if (!writeTimer) return;
    clearTimeout(writeTimer);
    writeTimer = null;
    writeSnapshot();
  };
  installExitHook();
  pendingExitFlushes.add(flushPending);

  const scheduleWrite = (): void => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeSnapshot();
    }, WRITE_DEBOUNCE_MS);
    // Never keep the daemon alive just to flush a board snapshot.
    writeTimer.unref?.();
  };

  return createReportStore({
    initialSlots: snapshot,
    beforePublish(next) {
      // The model sees success only after the whole batch is atomically on disk.
      // A failed rename leaves both the previous file and in-memory slots intact.
      persist(next);
      snapshot = next;
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
    },
    onChange(next) {
      snapshot = next;
      if (JSON.stringify(next) !== persistedBody) {
        scheduleWrite();
      }
    },
  });
}
