import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { GuidanceEntry } from './stimulus-delivery.js';
import { actionName, type OwnerRuntimeBackend } from './owner-system-prompt.js';
import { scheduledReport } from './report-prompts.js';

export type OwnerLane = 'source-delta' | 'hourly-reminder' | 'full-report' | 'owner-answer';

const LANES: readonly OwnerLane[] = [
  'source-delta',
  'hourly-reminder',
  'full-report',
  'owner-answer',
];

/** A lane's editable instruction is a workflow record at topic lane/<name>. */
export function isLaneRecord(entry: Pick<GuidanceEntry, 'kind' | 'topic'>): boolean {
  return entry.kind === 'workflow' && LANES.some((lane) => entry.topic === `lane/${lane}`);
}

function laneDefault(lane: OwnerLane, wikiEnabled: boolean): string[] {
  switch (lane) {
    case 'source-delta':
      return [
        'Decide whether each live source delta is chatter or an item of work that moved, including work requested, submitted, received, reviewed, given feedback, fixed, put on hold, or delivered.',
        "Before creating work, check the delta's candidates and what you already know; search the ledger or graph.query only for work you cannot place, so existing work is revised instead of duplicated.",
        'For a moved item, revise or create the work item with a summary of what changed and why, derived_from links to its observations, and the assignee and roles the evidence points to: who delivered or uploaded the work files, who handled its feedback, who was asked to do it. Record "unconfirmed" only when no observation points to anyone. Set eventDatetime to the source event time for that revision, not replay time.',
        'When current_work supplies a revision, pass it as expectedRevision to work.revise; for another write in the same window use the revision returned by the previous write. Read work.show only when a revise is rejected as stale or you need the item’s history.',
        'Update every board section the item appears in or leaves with report.publish. Read each section with report.read first unless this session already wrote it. Preserve every card that remains true and add, replace, or remove only cards for items that moved; never shrink a section to one item.',
        'Update briefing when the day’s key situation changes by revising its summary line and key-situation cards while keeping its other cards. Only a scheduled full report rewrites all four sections from scratch.',
        wikiEnabled
          ? 'For a replay window with end_of_window_instructions, finish the day’s work changes before updating each affected board section and topic wiki page.'
          : 'For a replay window with end_of_window_instructions, finish the day’s work changes before updating each affected board section.',
        ...(wikiEnabled
          ? ['Append a dated line to the moved item’s topic wiki page with manage.wiki.update.']
          : []),
        'Use [notify] when the owner should hear about this now; otherwise [ack].',
      ];
    case 'hourly-reminder':
      return [
        'Use what this owner session already knows and call work.list with view="pipeline" for the compact open-work list. Read source originals only when needed to resolve a material uncertainty.',
        'Call schedule.upcoming when this session has not read the calendar.',
        'Choose the open items that most need attention this hour, including every item waiting on an owner decision and any deadline affected by a calendar event or holiday.',
        'Summarize the handled source deltas supplied below as the changes since the previous reminder or full report.',
        'Update only action_required with report.publish({ slots: { action_required: "<html>" } }); scheduled full reports handle the other slots and wiki resync.',
        'Return a concise Korean reminder the owner can read at a glance, most urgent or nearest deadline first, under a short Korean title that names the top priorities.',
      ];
    case 'full-report':
      return [
        'Call source.recent for changes since the supplied prior full-report time, work.list with view="pipeline", and schedule.upcoming with days=14.',
        'Read originals with source.read when a recent line changes the report; distinguish an empty result from failed or stale collection.',
        'Compare every open deadline with the event and holiday calendar; use event end times when deciding whether a booking overlaps.',
        'Name work items under each stage. List every item waiting on an owner decision, with the decision requested.',
        'Say plainly when there were no changes. Include the owner schedule section and list its upcoming events and holidays.',
        'Publish all four board sections with report.publish before writing the text report.',
        ...(wikiEnabled
          ? [
              'After publishing the board, update each changed topic wiki page as a resync with manage.wiki.update, creating one with manage.wiki.publish only when no topic page fits; split separate topic page updates across subagents inside this turn. Write the daily/YYYY-MM-DD.md journal grouped by project with one entry per moved item, and put lessons under lessons/.',
            ]
          : []),
        'Write the Korean report in five parts, in order: key situation today; needs a response; needs a decision; pipeline with each stage and item; next actions. Put the owner schedule and holidays under key situation today.',
      ];
    case 'owner-answer':
      return [
        'Answer owner questions from what this session already knows. Read only what is needed to confirm a fact or learn something not yet known.',
        'An owner-requested report is text. Publish the board only when the owner turn changed work.',
        'Keep the answer concise, with no working notes, narration about answering, or record or observation ids.',
      ];
  }
}

export function laneForStimulus(
  kind: string | null,
  payload: JsonValue | undefined
): OwnerLane | null {
  if (kind === 'source_delta') return 'source-delta';
  if (kind === 'owner_message') return 'owner-answer';
  if (kind === 'scheduled') {
    return scheduledReport(payload).report === 'full' ? 'full-report' : 'hourly-reminder';
  }
  return null;
}

const ACTION_NAMES = [
  'work.list',
  'work.show',
  'work.revise',
  'work.create',
  'graph.query',
  'report.publish',
  'report.read',
  'source.recent',
  'source.read',
  'schedule.upcoming',
  'manage.wiki.update',
  'manage.wiki.publish',
  'memory.save',
  'memory.retire',
];

export function renderLaneInstructions(
  lane: OwnerLane,
  entries: readonly GuidanceEntry[],
  backend: OwnerRuntimeBackend = 'codex',
  wikiEnabled = true
): string {
  const record = entries
    .filter(
      (entry) =>
        entry.kind === 'workflow' && entry.topic === `lane/${lane}` && entry.status === 'active'
    )
    .sort((left, right) => {
      const timeOrder = String(right.updated_at).localeCompare(String(left.updated_at));
      return timeOrder || right.id.localeCompare(left.id);
    })[0];
  // A workflow's summary and ordered steps are the instruction; its details explain why.
  const lines = record ? [record.summary, ...(record.steps ?? [])] : laneDefault(lane, wikiEnabled);
  const project = (line: string): string =>
    ACTION_NAMES.reduce(
      (text, action) => text.replaceAll(action, actionName(backend, action)),
      line
    );
  const replaces = record
    ? `, replaces=[{id: "${record.id}", reason: "the owner corrected this lane"}]`
    : '';
  return [
    `<lane-instructions lane="${lane}" record="${record?.id ?? 'default'}">`,
    ...lines.filter((line) => line.trim() !== '').map(project),
    ...(record && !wikiEnabled ? ['wiki: disabled; skip any wiki step above.'] : []),
    `Change this lane by saving a workflow with topic="lane/${lane}", its summary and one step per instruction line${replaces}, using ${actionName(backend, 'memory.save')}.`,
    '</lane-instructions>',
  ].join('\n');
}
