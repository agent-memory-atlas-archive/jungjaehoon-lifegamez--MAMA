import { useEffect, useRef, type RefObject } from 'react';
import type {
  OperatorTask,
  OperatorTaskDetail,
  OperatorTaskEvidence,
  OperatorTaskRevision,
  TaskStatus,
} from '../api/client';
import DrawerDetail from './DrawerDetail';
import { shouldShowModal } from '../lib/dialog-state';
import { lockScrollBehind } from '../lib/scroll-lock';
import { presentTaskTemporal } from '../lib/task-temporal';
import { formatRelativeTime } from '../lib/time';

const STATUS_CLASSES: Record<TaskStatus, string> = {
  pending: 'bg-surface-secondary text-text-secondary',
  in_progress: 'bg-agent-light text-agent-strong',
  review: 'bg-warning-soft text-warning-text',
  blocked: 'bg-warning-soft text-warning-text',
  done: 'bg-success-soft text-success-text',
  cancelled: 'bg-surface-secondary text-text-secondary',
};

/**
 * What the drawer says when the ledger row carries no evidence link. The
 * drawer is bounded on purpose: it shows the task row and the bounded
 * source.read observations cited by its revisions.
 */
const NO_SOURCE = 'No linked source recorded';

interface TaskDrawerProps {
  task: OperatorTask;
  detail?: OperatorTaskDetail;
  detailError?: string | null;
  now: number;
  opener: HTMLElement | null;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
}

function absoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => value !== undefined && value !== null && value !== ''
      )
    ),
  ];
}

function uniqueEvidence(evidence: OperatorTaskEvidence[]): OperatorTaskEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.observationRef)) return false;
    seen.add(item.observationRef);
    return true;
  });
}

function patchText(revision: OperatorTaskRevision): string | null {
  const set = Object.entries(revision.change).map(([key, value]) => {
    const serialized = JSON.stringify(value);
    return `${key}: ${serialized === undefined ? String(value) : serialized}`;
  });
  const clear = revision.clear.map((key) => `${key}: cleared`);
  const parts = [...set, ...clear];
  return parts.length > 0 ? parts.join('; ') : null;
}

function EvidenceBlock({ evidence }: { evidence: OperatorTaskEvidence }) {
  return (
    <div className="rounded-lg border border-border bg-surface-secondary px-3 py-2">
      <div className="text-[11px] font-semibold text-text-secondary">
        {evidence.observationRef}
        {evidence.channel || evidence.source ? ` · ${evidence.channel ?? evidence.source}` : ''}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs text-text">{evidence.content}</p>
    </div>
  );
}

function RevisionEntry({ revision }: { revision: OperatorTaskRevision }) {
  const changes = patchText(revision);
  return (
    <article className="rounded-lg border border-border bg-surface-secondary px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <h4 className="text-sm font-semibold text-text">
          Revision {revision.revision} · {revision.operation}
        </h4>
        <time className="shrink-0 text-right text-[11px] text-text-secondary">
          {revision.eventTimeSource === 'event' ? 'Event time' : 'Recorded time'}
          <br />
          {absoluteTime(revision.eventTime)}
        </time>
      </div>
      <dl className="mt-3 space-y-3">
        {revision.summary && <DrawerDetail label="Summary">{revision.summary}</DrawerDetail>}
        {revision.reasoning && <DrawerDetail label="Why">{revision.reasoning}</DrawerDetail>}
        {changes && <DrawerDetail label="Changed">{changes}</DrawerDetail>}
        {revision.feedback && <DrawerDetail label="Feedback">{revision.feedback}</DrawerDetail>}
      </dl>
      {revision.evidence.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            Cited observations
          </div>
          {revision.evidence.map((evidence) => (
            <EvidenceBlock
              key={`${revision.revision}-${evidence.observationRef}`}
              evidence={evidence}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export default function TaskDrawer({
  task,
  detail,
  detailError,
  now,
  opener,
  fallbackFocusRef,
  onDismiss,
}: TaskDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (shouldShowModal(dialog.open)) {
      dialog.showModal();
      closeButtonRef.current?.focus();
    }

    return lockScrollBehind(dialog);
  }, [task.id]);

  const requestClose = () => {
    if (dialogRef.current?.open) {
      dialogRef.current.close();
    }
  };

  // Escape reaches the dialog as `cancel`; both paths land here, so focus
  // returns to the row button that opened the drawer either way.
  const handleClose = () => {
    onDismiss();
    window.queueMicrotask(() => {
      if (opener?.isConnected) {
        opener.focus();
      } else {
        fallbackFocusRef.current?.focus();
      }
    });
  };

  const temporal = presentTaskTemporal({
    temporalState: task.temporal_state,
    dueAt: task.due_at,
    dueDate: task.due_date,
  });
  const revisions = detail?.revisions ?? [];
  const allEvidence = revisions.flatMap((revision) => revision.evidence);
  const citedEvidence = uniqueEvidence(allEvidence);
  const sourceChannels = uniqueStrings([
    task.source_channel,
    ...allEvidence.map((evidence) => evidence.channel ?? evidence.source),
  ]);
  const createdAt = detail?.createdAt ?? task.created_at;
  const updatedAt = detail?.updatedAt ?? task.updated_at;

  return (
    <dialog
      ref={dialogRef}
      className="task-drawer"
      aria-labelledby="task-drawer-title"
      aria-describedby="task-drawer-description"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClose={handleClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col bg-surface text-text">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="task-drawer-title" className="break-words text-lg font-semibold text-text">
              #{task.id} {task.title}
            </h2>
            <p id="task-drawer-description" className="mt-1 text-xs text-text-secondary">
              Ledger record with bounded cited source evidence.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            autoFocus
            onClick={requestClose}
            className="shrink-0 rounded-lg border border-border bg-surface-secondary px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover focus:ring-2 focus:ring-agent-strong"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <section aria-labelledby="task-status-heading">
            <h3 id="task-status-heading" className="text-sm font-semibold text-text">
              Status
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <DrawerDetail label="Workflow status">
                <span
                  className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_CLASSES[task.status]}`}
                >
                  {task.status.replace('_', ' ')}
                </span>
              </DrawerDetail>
              <DrawerDetail label="Priority">{task.priority}</DrawerDetail>
              <DrawerDetail label="Assignee">{task.assignee || 'unassigned'}</DrawerDetail>
              <DrawerDetail label="Owner confirmation">
                {task.auto_created
                  ? task.confirmed
                    ? 'Auto-created, confirmed'
                    : 'Auto-created, unconfirmed'
                  : 'Owner-created'}
              </DrawerDetail>
            </dl>
          </section>

          <section aria-labelledby="task-schedule-heading">
            <h3 id="task-schedule-heading" className="text-sm font-semibold text-text">
              Schedule
            </h3>
            <dl className="mt-3 space-y-3">
              <DrawerDetail label="Temporal state">
                {temporal.badgeLabel} - {temporal.fact}
              </DrawerDetail>
              <DrawerDetail label="Due">{temporal.dueLabel}</DrawerDetail>
              <DrawerDetail label="Created">{absoluteTime(createdAt)}</DrawerDetail>
              <DrawerDetail label="Updated">
                {absoluteTime(updatedAt)} ({formatRelativeTime(now, updatedAt)})
              </DrawerDetail>
            </dl>
          </section>

          <section aria-labelledby="task-source-heading">
            <h3 id="task-source-heading" className="text-sm font-semibold text-text">
              Source evidence
            </h3>
            <dl className="mt-3 space-y-3">
              <DrawerDetail label="Source channel">
                {sourceChannels.length > 0 ? sourceChannels.join(', ') : NO_SOURCE}
              </DrawerDetail>
              {citedEvidence.length > 0 && (
                <DrawerDetail label="Cited observations">
                  <div className="space-y-2">
                    {citedEvidence.map((evidence) => (
                      <EvidenceBlock key={evidence.observationRef} evidence={evidence} />
                    ))}
                  </div>
                </DrawerDetail>
              )}
            </dl>
            <p className="mt-2 text-xs text-text-secondary">
              Each cited observation is a bounded source.read slice identified by observation id.
            </p>
          </section>

          <section aria-labelledby="task-history-heading">
            <h3 id="task-history-heading" className="text-sm font-semibold text-text">
              History
            </h3>
            {detailError ? (
              <p role="alert" className="mt-2 text-sm text-warning-text">
                {detailError}
              </p>
            ) : detail === undefined ? (
              <p className="mt-2 text-sm text-text-secondary">Loading task history...</p>
            ) : revisions.length === 0 ? (
              <p className="mt-2 text-sm text-text-secondary">No revisions recorded.</p>
            ) : (
              <div className="mt-3 space-y-4">
                {revisions.map((revision) => (
                  <RevisionEntry key={revision.revision} revision={revision} />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="task-ledger-heading">
            <h3 id="task-ledger-heading" className="text-sm font-semibold text-text">
              Recent ledger context
            </h3>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-text-secondary">
              {task.latest_event || NO_SOURCE}
            </p>
          </section>
        </div>
      </div>
    </dialog>
  );
}
