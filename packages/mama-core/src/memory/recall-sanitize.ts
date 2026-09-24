/**
 * Recall-surface text redaction, owned by the core so every read surface scrubs
 * the same way. The provenance action passes this as its `redact` - a caller
 * never supplies the scrub, because a citation that lets the caller choose the
 * redaction would let them choose none.
 */
const RECALL_TEXT_REDACTION_PATTERNS = [
  /MAMA_SYNTHETIC_[A-Z0-9_]+_DO_NOT_LEAK/g,
  /synthetic:\/\/raw[^\s"']*/g,
  /raw:[^\s"']*/g,
  /\bhttps?:\/\/[^\s"'<>()]+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:Bearer|Token|Authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s"']{8,}/gi,
  /(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /sk-[A-Za-z0-9_-]{20,}\b/g,
  /\b[CU][A-Z0-9]{8,}\b/g,
  /\b[0-9]{17,20}\b/g,
  /(?:\/Users|\/home|\/tmp)\/[^\s"']*/g,
  /[A-Za-z]:\\Users\\[^\s"']*/g,
] as const;
const MAX_RECALL_TEXT_LENGTH = 280;
const RECALL_TEXT_REDACTION_SCAN_LIMIT = MAX_RECALL_TEXT_LENGTH + 2048;

export function sanitizeRecallText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  let sanitized =
    value.length > RECALL_TEXT_REDACTION_SCAN_LIMIT
      ? value.slice(0, RECALL_TEXT_REDACTION_SCAN_LIMIT)
      : value;
  for (const pattern of RECALL_TEXT_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[redacted]');
  }
  const wasTruncated =
    value.length > MAX_RECALL_TEXT_LENGTH || sanitized.length > MAX_RECALL_TEXT_LENGTH;
  if (sanitized.length > MAX_RECALL_TEXT_LENGTH) {
    sanitized = sanitized.slice(0, MAX_RECALL_TEXT_LENGTH);
  }
  if (wasTruncated) {
    sanitized = `${sanitized} [truncated]`;
  }
  return sanitized;
}

/**
 * The shape a recall answers in.
 *
 * memory.read:topic returned recallMemory's records verbatim; the scrub and this
 * narrowing lived in a host tool case that wrapped the action, so a caller
 * naming the action got unredacted full records. Provenance already scrubbed its
 * excerpts - topic simply did not - and the two read surfaces have to answer the
 * same way.
 */
export interface SafeRecallMemory {
  /**
   * Handle for the recalled record.
   *
   * Without this the agent receives prose it cannot point at: it can read a
   * memory and then has no way to say WHICH memory a statement rests on, so a
   * claim can never be traced back to its evidence and a correction has no
   * address. The id is an opaque identifier, not content, so returning it
   * discloses nothing the summary does not.
   */
  memoryId?: string;
  topic?: string;
  kind?: string;
  summary?: string;
  confidence?: number;
  status?: string;
  /**
   * SUCCESS / FAILED / PARTIAL, or null.
   *
   * Not free text, so it discloses nothing the summary does not - and a reader
   * that cannot see it presents a failed decision as if it still held. The
   * projection was tuned to one consumer before it became the action's answer
   * for all of them, and dropping this is what that cost.
   */
  outcome?: string;
}

export interface SafeRecallProfileEvidence {
  topic?: string;
}

export interface SafeRecallBundle {
  profile: {
    static: SafeRecallMemory[];
    dynamic: SafeRecallMemory[];
    evidence: SafeRecallProfileEvidence[];
  };
  memories: SafeRecallMemory[];
  graph_context: {
    primary: SafeRecallMemory[];
    expanded: SafeRecallMemory[];
    edge_count: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeRecallMemory(value: unknown): SafeRecallMemory | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const safe: SafeRecallMemory = {};
  const memoryId = stringField(record, 'id');
  if (memoryId) {
    safe.memoryId = memoryId;
  }
  const topic = sanitizeRecallText(stringField(record, 'topic'));
  const kind = sanitizeRecallText(stringField(record, 'kind'));
  const summary = sanitizeRecallText(stringField(record, 'summary'));
  const status = sanitizeRecallText(stringField(record, 'status'));
  const outcome = sanitizeRecallText(stringField(record, 'outcome'));
  const confidence = numberField(record, 'confidence');
  if (topic) {
    safe.topic = topic;
  }
  if (kind) {
    safe.kind = kind;
  }
  if (summary) {
    safe.summary = summary;
  }
  if (status) {
    safe.status = status;
  }
  if (outcome) {
    safe.outcome = outcome;
  }
  if (confidence !== undefined) {
    safe.confidence = confidence;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function sanitizeRecallMemories(value: unknown): SafeRecallMemory[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((memory) => sanitizeRecallMemory(memory))
    .filter((memory): memory is SafeRecallMemory => memory !== null);
}

function sanitizeProfileEvidence(value: unknown): SafeRecallProfileEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      const evidence: SafeRecallProfileEvidence = {};
      const topic = sanitizeRecallText(stringField(record, 'topic'));
      if (topic) {
        evidence.topic = topic;
      }
      return Object.keys(evidence).length > 0 ? evidence : null;
    })
    .filter((evidence): evidence is SafeRecallProfileEvidence => evidence !== null);
}

/** Scrub a recall bundle and narrow it to the fields a read may answer with. */
export function sanitizeRecallBundle(bundle: unknown): SafeRecallBundle {
  const record = asRecord(bundle) ?? {};
  const profile = asRecord(record.profile) ?? {};
  const graphContext = asRecord(record.graph_context) ?? {};
  const edges = Array.isArray(graphContext.edges) ? graphContext.edges : [];

  return {
    profile: {
      static: sanitizeRecallMemories(profile.static),
      dynamic: sanitizeRecallMemories(profile.dynamic),
      evidence: sanitizeProfileEvidence(profile.evidence),
    },
    memories: sanitizeRecallMemories(record.memories),
    graph_context: {
      primary: sanitizeRecallMemories(graphContext.primary),
      expanded: sanitizeRecallMemories(graphContext.expanded),
      edge_count: edges.length,
    },
  };
}
