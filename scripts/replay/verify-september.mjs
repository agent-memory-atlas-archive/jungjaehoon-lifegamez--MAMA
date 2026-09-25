#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

function fail(message) {
  throw new Error(message);
}

function epoch(value, field) {
  if (value === undefined) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  fail(`${field} must be a timezone-qualified timestamp or epoch milliseconds`);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) {
      fail(`Unknown argument ${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`${name} requires a value`);
    }
    values.set(name.slice(2), value);
    index += 1;
  }
  const home = process.env.MAMA_HOME ?? join(homedir(), '.mama');
  return {
    kagemushaDb: resolve(
      values.get('kagemusha-db') ?? join(dirname(home), '.kagemusha', 'kagemusha.db')
    ),
    mamaDb: resolve(values.get('mama-db') ?? join(home, 'memory.db')),
    rawRoot: resolve(values.get('raw-root') ?? join(home, 'connectors')),
    reportSlots: resolve(values.get('report-slots') ?? join(home, 'runtime', 'report-slots.json')),
    wikiRoot: resolve(values.get('wiki-root') ?? join(home, 'wiki', 'pages')),
    manifest: resolve(
      values.get('manifest') ?? join(home, 'runtime', 'september-import-manifest.json')
    ),
    ledger: resolve(values.get('ledger') ?? join(home, 'runtime', 'september-replay-ledger.jsonl')),
    cursor: resolve(values.get('cursor') ?? join(home, 'runtime', 'september-replay-cursor.json')),
    fromMs: epoch(values.get('from'), 'from'),
    untilMs: epoch(values.get('until'), 'until'),
  };
}

function openReadOnly(path, field) {
  if (!existsSync(path)) {
    fail(`${field} does not exist`);
  }
  return new DatabaseSync(path, { readOnly: true, fileMustExist: true });
}

function day(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function countKey(origin, date) {
  return `${origin}\0${date}`;
}

function addCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function mapCounts(map) {
  const result = {};
  for (const key of [...map.keys()].sort()) {
    const [origin, date] = key.split('\0');
    result[`${origin}/${date}`] = map.get(key);
  }
  return result;
}

function readJson(path, field) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${field} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readManifest(path) {
  const manifest = readJson(path, 'import manifest');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('import manifest is invalid');
  }
  if (!Number.isSafeInteger(manifest.fromMs) || !Number.isSafeInteger(manifest.untilMs)) {
    fail('import manifest fence is invalid');
  }
  return manifest;
}

function readKagemusha(path, fromMs, untilMs) {
  const db = openReadOnly(path, 'Kagemusha database');
  try {
    const counts = new Map();
    const stableIds = new Map();
    const rows = db
      .prepare(
        `SELECT id, channel, created_at
           FROM channel_messages
          WHERE role = 'user' AND created_at >= ? AND created_at < ?`
      )
      .all(fromMs, untilMs);
    for (const row of rows) {
      const origin = String(row.channel);
      const date = day(Number(row.created_at));
      addCount(counts, countKey(origin, date));
      const ids = stableIds.get(origin) ?? new Set();
      ids.add(String(row.id));
      stableIds.set(origin, ids);
    }
    return { counts, stableIds };
  } finally {
    db.close();
  }
}

function rawDatabases(rawRoot) {
  if (!existsSync(rawRoot)) {
    fail('raw root does not exist');
  }
  return readdirSync(rawRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rawRoot, entry.name, 'raw.db'))
    .filter((path) => existsSync(path))
    .sort();
}

function metadata(value) {
  if (value === null || value === undefined) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readRaw(rawRoot, fromMs, untilMs) {
  const counts = new Map();
  const feedbackCounts = new Map();
  const stableIds = new Map();
  const trelloCounts = new Map();
  for (const path of rawDatabases(rawRoot)) {
    const db = openReadOnly(path, 'raw database');
    try {
      const rows = db
        .prepare(
          `SELECT source_id, timestamp, type, metadata
             FROM raw_items
            WHERE timestamp >= ? AND timestamp < ?`
        )
        .all(fromMs, untilMs);
      for (const row of rows) {
        const data = metadata(row.metadata);
        const origin = typeof data.originalPlatform === 'string' ? data.originalPlatform : null;
        if (row.type === 'message' && origin) {
          const date = day(Number(row.timestamp));
          addCount(origin === 'feedback' ? feedbackCounts : counts, countKey(origin, date));
          const ids = stableIds.get(origin) ?? new Set();
          ids.add(String(data.kagemushaMessageId ?? row.source_id));
          stableIds.set(origin, ids);
        }
        if (row.type === 'kanban_card') {
          const board = typeof data.boardId === 'string' ? data.boardId : null;
          if (board) {
            addCount(trelloCounts, countKey(board, day(Number(row.timestamp))));
          }
        }
      }
    } finally {
      db.close();
    }
  }
  return { counts, feedbackCounts, stableIds, trelloCounts };
}

function readBoard(path) {
  const snapshot = readJson(path, 'report slot snapshot');
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('report slot snapshot is invalid');
  }
  const updates = {};
  let slotCount = 0;
  for (const slot of Object.values(snapshot)) {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      continue;
    }
    slotCount += 1;
    if (typeof slot.updatedAt === 'number' && Number.isSafeInteger(slot.updatedAt)) {
      const date = slot.updatedAt < 0 ? 'invalid' : day(slot.updatedAt);
      updates[date] = (updates[date] ?? 0) + 1;
    }
  }
  return { slotCount, updatesByDay: updates };
}

function readWikiRoot(root) {
  if (!existsSync(root)) {
    fail('wiki root does not exist');
  }
  let pageCount = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        pageCount += 1;
      }
    }
  };
  visit(root);
  return { pageCount };
}

function compareCountMaps(left, right) {
  const keys = new Set([...left.keys(), ...right.keys()]);
  let differences = 0;
  for (const key of keys) {
    if ((left.get(key) ?? 0) !== (right.get(key) ?? 0)) {
      differences += 1;
    }
  }
  return differences;
}

function missingStableIds(source, imported) {
  let missing = 0;
  for (const [origin, ids] of source) {
    const actual = imported.get(origin) ?? new Set();
    for (const id of ids) {
      if (!actual.has(id)) {
        missing += 1;
      }
    }
  }
  return missing;
}

function compareManifestCounts(expected, actual) {
  const expectedMap = new Map();
  for (const [origin, dates] of Object.entries(expected ?? {})) {
    for (const [date, count] of Object.entries(dates ?? {})) {
      expectedMap.set(countKey(origin, date), Number(count));
    }
  }
  const actualMap = new Map(actual);
  const keys = new Set([...expectedMap.keys(), ...actualMap.keys()]);
  let differences = 0;
  for (const key of keys) {
    if ((expectedMap.get(key) ?? 0) !== (actualMap.get(key) ?? 0)) {
      differences += 1;
    }
  }
  return { expectedMap, differences };
}

function readLedger(path) {
  const source = readFileSync(path, 'utf8');
  const entries = source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  let sequenceViolations = 0;
  let previous = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence !== previous + 1) {
      sequenceViolations += 1;
    }
    previous = Number(entry.sequence);
  }
  const accepted = entries.filter((entry) => entry.status === 'accepted');
  let orderViolations = 0;
  let windowRefViolations = 0;
  let lastFirst = null;
  const byStimulus = new Map();
  for (const entry of accepted) {
    if (lastFirst !== null && Number(entry.firstSourceAtMs) < lastFirst) {
      orderViolations += 1;
    }
    lastFirst = Number(entry.firstSourceAtMs);
    if (
      Number(entry.firstSourceAtMs) < Number(entry.windowStartMs) ||
      Number(entry.lastSourceAtMs) >= Number(entry.windowEndMs)
    ) {
      windowRefViolations += 1;
    }
    byStimulus.set(entry.stimulusId, (byStimulus.get(entry.stimulusId) ?? 0) + 1);
  }
  let duplicateDeliveries = 0;
  for (const count of byStimulus.values()) {
    if (count > 1) {
      duplicateDeliveries += count - 1;
    }
  }

  const pending = new Map();
  let windowViolations = 0;
  for (const entry of entries) {
    if (entry.status === 'accepted') {
      const currentWindow = Number(entry.windowStartMs);
      if ([...pending.values()].some((windowStart) => windowStart < currentWindow)) {
        windowViolations += 1;
      }
      pending.set(entry.stimulusId, currentWindow);
    } else if (
      entry.status === 'settled' ||
      entry.status === 'dead' ||
      entry.status === 'uncertain'
    ) {
      pending.delete(entry.stimulusId);
    }
  }
  return {
    entries,
    sequenceViolations,
    orderViolations,
    windowRefViolations,
    windowViolations,
    duplicateDeliveries,
    deadDeliveries: entries.filter((entry) => entry.status === 'dead').length,
    uncertainDeliveries: entries.filter((entry) => entry.status === 'uncertain').length,
  };
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function collectCitations(value, key, result) {
  const lower = String(key ?? '').toLowerCase();
  const citationKey = new Set([
    'commitmentid',
    'observationref',
    'observationrefs',
    'evidencerefs',
    'sourcerefs',
  ]);
  if (typeof value === 'string' && citationKey.has(lower)) {
    result.push({
      kind:
        lower === 'commitmentid'
          ? 'commitment'
          : lower === 'evidencerefs' || lower.includes('observation')
            ? 'observation'
            : 'source',
      value,
    });
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      collectCitations(child, key, result);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  if (value.target && value.target.kind === 'observation' && typeof value.target.id === 'string') {
    result.push({ kind: 'observation', value: value.target.id });
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectCitations(child, childKey, result);
  }
}

function unresolvedCitations(db) {
  const commitments = new Set(
    db
      .prepare('SELECT commitment_id FROM commitments')
      .all()
      .map((row) => String(row.commitment_id))
  );
  const observations = new Set(
    db
      .prepare('SELECT observation_id FROM observation_versions')
      .all()
      .map((row) => String(row.observation_id))
  );
  const decisions = new Set(
    db
      .prepare('SELECT id FROM decisions')
      .all()
      .map((row) => String(row.id))
  );
  const citations = [];
  for (const row of db.prepare('SELECT source_refs_json, payload_json FROM decisions').all()) {
    collectCitations(parseMaybeJson(row.source_refs_json), 'sourceRefs', citations);
    collectCitations(parseMaybeJson(row.payload_json), 'payload', citations);
  }
  for (const row of db.prepare('SELECT set_json, clear_json FROM commitment_assignments').all()) {
    collectCitations(parseMaybeJson(row.set_json), 'set', citations);
    collectCitations(parseMaybeJson(row.clear_json), 'clear', citations);
  }
  let missing = 0;
  for (const citation of citations) {
    if (citation.kind === 'commitment' && !commitments.has(citation.value)) {
      missing += 1;
    }
    if (citation.kind === 'observation' && !observations.has(citation.value)) {
      missing += 1;
    }
    if (
      citation.kind === 'source' &&
      !decisions.has(citation.value) &&
      !observations.has(citation.value) &&
      !commitments.has(citation.value)
    ) {
      missing += 1;
    }
  }
  return missing;
}

const DURABLE_WRITE_TOOLS = [
  'work.create',
  'work.revise',
  'work.withdraw',
  'work.update',
  'work.reclassify',
  'memory.save',
  'report.publish',
  'manage.wiki.publish',
  'source.ingest',
  'identity.correct',
];

function subagentWriteChecks(db) {
  const placeholders = DURABLE_WRITE_TOOLS.map(() => '?').join(', ');
  const childModelRuns = Number(
    db
      .prepare('SELECT COUNT(*) AS count FROM model_runs WHERE parent_model_run_id IS NOT NULL')
      .get().count
  );
  const childTraceCount = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM tool_traces t
           JOIN model_runs m ON m.model_run_id = t.model_run_id
          WHERE m.parent_model_run_id IS NOT NULL`
      )
      .get().count
  );
  const childWriteTraces = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM tool_traces t
           JOIN model_runs m ON m.model_run_id = t.model_run_id
          WHERE m.parent_model_run_id IS NOT NULL
            AND t.tool_name IN (${placeholders})`
      )
      .get(...DURABLE_WRITE_TOOLS).count
  );
  const parentWriteTraces = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM tool_traces t
           JOIN model_runs m ON m.model_run_id = t.model_run_id
          WHERE m.parent_model_run_id IS NULL
            AND t.tool_name IN (${placeholders})`
      )
      .get(...DURABLE_WRITE_TOOLS).count
  );
  const writesWithoutModelRun = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM tool_traces t
           LEFT JOIN model_runs m ON m.model_run_id = t.model_run_id
          WHERE t.tool_name IN (${placeholders})
            AND (t.model_run_id IS NULL OR m.model_run_id IS NULL)`
      )
      .get(...DURABLE_WRITE_TOOLS).count
  );
  return {
    childModelRuns,
    childTraceCount,
    childWriteTraces,
    parentWriteTraces,
    writesWithoutModelRun,
  };
}

function readDatabaseChecks(path) {
  const db = openReadOnly(path, 'MAMA database');
  try {
    const revisionRows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', event_datetime/1000, 'unixepoch', '+09:00') AS day, COUNT(*) AS count
           FROM decisions
          WHERE record_kind = 'commitment' AND event_datetime IS NOT NULL
          GROUP BY day ORDER BY day`
      )
      .all();
    const byDay = Object.fromEntries(
      revisionRows.map((row) => [String(row.day), Number(row.count)])
    );
    const nullEventDatetime = Number(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM decisions WHERE record_kind='commitment' AND event_datetime IS NULL"
        )
        .get().count
    );
    const nullAssignmentAppliesFrom = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM commitment_assignments a
             JOIN decisions d ON d.id = a.record_id
            WHERE d.record_kind = 'commitment' AND a.applies_from IS NULL`
        )
        .get().count
    );
    const assignments = db.prepare('SELECT set_json FROM commitment_assignments').all();
    const shape = {
      revisions: assignments.length,
      withStage: 0,
      withProject: 0,
      withLastEventTime: 0,
      withFiles: 0,
      withRoles: 0,
    };
    for (const row of assignments) {
      const value = parseMaybeJson(row.set_json) ?? {};
      for (const field of ['stage', 'project', 'lastEventTime', 'files', 'roles']) {
        if (Object.prototype.hasOwnProperty.call(value, field) && value[field] !== null) {
          shape[
            field === 'lastEventTime'
              ? 'withLastEventTime'
              : `with${field[0].toUpperCase()}${field.slice(1)}`
          ] += 1;
        }
      }
    }
    const lessons = {
      count: Number(
        db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE kind = 'lesson'").get().count
      ),
      withDerivedFrom: Number(
        db
          .prepare(
            `SELECT COUNT(DISTINCT e.subject_id) AS count
               FROM twin_edges e
               JOIN decisions d ON d.id = e.subject_id
              WHERE d.kind = 'lesson' AND e.edge_type = 'derived_from'`
          )
          .get().count
      ),
    };
    return {
      revisionEventTimes: { byDay, nullEventDatetime, nullAssignmentAppliesFrom },
      taskShape: shape,
      lessons,
      unresolvableCitations: unresolvedCitations(db),
      subagentWrites: subagentWriteChecks(db),
    };
  } finally {
    db.close();
  }
}

export function verifySeptember(input) {
  const manifest = readManifest(input.manifest);
  const fromMs = input.fromMs ?? manifest.fromMs;
  const untilMs = input.untilMs ?? manifest.untilMs;
  if (untilMs < fromMs) {
    fail('verification fence is invalid');
  }
  const source = readKagemusha(input.kagemushaDb, fromMs, untilMs);
  const raw = readRaw(input.rawRoot, fromMs, untilMs);
  const importDifference = compareCountMaps(source.counts, raw.counts);
  const feedbackManifest = compareManifestCounts(
    manifest.countsByOriginDay === undefined
      ? undefined
      : { feedback: manifest.countsByOriginDay.feedback ?? {} },
    raw.feedbackCounts
  );
  const missingStableIds = missingStableIdsCount(source.stableIds, raw.stableIds);
  const trelloManifest = compareManifestCounts(manifest.trelloCountsByBoardDay, raw.trelloCounts);
  const ledger = readLedger(input.ledger);
  const cursor = readJson(input.cursor, 'replay cursor');
  const cursorViolations = cursor.version !== 1 || cursor.nextWindowStartMs !== untilMs ? 1 : 0;
  const database = readDatabaseChecks(input.mamaDb);
  const board = readBoard(input.reportSlots);
  const wiki = readWikiRoot(input.wikiRoot);
  const result = {
    importCoverage: {
      byOriginDay: mapCounts(raw.counts),
      sourceRows: [...source.counts.values()].reduce((sum, count) => sum + count, 0),
      importedRows: [...raw.counts.values()].reduce((sum, count) => sum + count, 0),
      differences: importDifference,
      missingStableIds,
      feedbackDifferences: feedbackManifest.differences,
      feedbackRows: [...raw.feedbackCounts.values()].reduce((sum, count) => sum + count, 0),
    },
    trelloCoverage: {
      byBoardDay: mapCounts(raw.trelloCounts),
      manifestRows: [...trelloManifest.expectedMap.values()].reduce((sum, count) => sum + count, 0),
      rawRows: [...raw.trelloCounts.values()].reduce((sum, count) => sum + count, 0),
      differences: trelloManifest.differences,
    },
    replayOrder: {
      ledgerEntries: ledger.entries.length,
      sequenceViolations: ledger.sequenceViolations,
      orderViolations: ledger.orderViolations,
      windowRefViolations: ledger.windowRefViolations,
      windowViolations: ledger.windowViolations,
      duplicateDeliveries: ledger.duplicateDeliveries,
      deadDeliveries: ledger.deadDeliveries,
      uncertainDeliveries: ledger.uncertainDeliveries,
      cursorViolations,
    },
    revisionEventTimes: database.revisionEventTimes,
    taskShape: database.taskShape,
    board,
    wiki,
    lessons: database.lessons,
    unresolvableCitations: database.unresolvableCitations,
    subagentWrites: database.subagentWrites,
  };
  const failures =
    result.importCoverage.differences +
    result.importCoverage.missingStableIds +
    result.importCoverage.feedbackDifferences +
    result.trelloCoverage.differences +
    result.replayOrder.sequenceViolations +
    result.replayOrder.orderViolations +
    result.replayOrder.windowRefViolations +
    result.replayOrder.windowViolations +
    result.replayOrder.duplicateDeliveries +
    result.replayOrder.deadDeliveries +
    result.replayOrder.uncertainDeliveries +
    result.replayOrder.cursorViolations +
    result.revisionEventTimes.nullEventDatetime +
    result.revisionEventTimes.nullAssignmentAppliesFrom +
    (result.lessons.count - result.lessons.withDerivedFrom) +
    result.unresolvableCitations +
    result.subagentWrites.childWriteTraces +
    result.subagentWrites.writesWithoutModelRun;
  return { result, failures };
}

function missingStableIdsCount(source, imported) {
  return missingStableIds(source, imported);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const verified = verifySeptember(args);
    console.log(JSON.stringify(verified.result));
    if (verified.failures > 0) {
      process.exitCode = 1;
    }
  } catch {
    // Verification output is counts-only. A malformed invocation is a failed
    // command, not a reason to print source values or database contents.
    process.exitCode = 1;
  }
}
