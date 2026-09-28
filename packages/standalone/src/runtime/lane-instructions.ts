import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import type { GuidanceEntry } from './stimulus-delivery.js';
import { actionName, type OwnerRuntimeBackend } from './owner-system-prompt.js';
import { scheduledReport } from './report-prompts.js';

export type OwnerLane = 'source-delta' | 'hourly-reminder' | 'full-report' | 'owner-answer';

const laneDefaults: Readonly<Record<OwnerLane, string>> = {
  'source-delta': [
    'Decide whether each live source delta is chatter or an item of work that moved, including work requested, submitted, received, reviewed, given feedback, fixed, put on hold, or delivered.',
    "Before creating work, check the delta's candidates and what you already know; search the ledger or graph.query only for work you cannot place, so existing work is revised instead of duplicated.",
    'For a moved item, revise or create the work item with a summary of what changed and why, derived_from links to its observations, and the assignee and roles supported by the evidence. Set eventDatetime to the source event time for that revision, not replay time.',
    'When current_work supplies a revision, pass it as expectedRevision to work.revise; for another write in the same window use the revision returned by the previous write.',
    'Update every board section the item appears in or leaves with report.publish. Read each section with report.read first unless this session already wrote it. Preserve every card that remains true and add, replace, or remove only cards for items that moved; never shrink a section to one item.',
    'Update briefing when the day’s key situation changes by revising its summary line and key-situation cards while keeping its other cards. Only a scheduled full report rewrites all four sections from scratch.',
    'For a replay window with end_of_window_instructions, finish the day’s work changes before updating each affected board section and topic wiki page.',
    'When enabled, append a dated line to the moved item’s topic wiki page with manage.wiki.update.',
    'End with [notify] and a short message when the owner should hear about this now; otherwise end with [ack].',
  ].join('\n'),
  'hourly-reminder': [
    'Use what this owner session already knows and call work.list with view="pipeline" for the compact open-work list. Read source originals only when needed to resolve a material uncertainty.',
    'Call schedule.upcoming when this session has not read the calendar.',
    'Choose the open items that most need attention this hour, including every item waiting on an owner decision and any deadline affected by a calendar event or holiday.',
    'Use the acknowledged source deltas supplied below to summarize changes since the previous reminder or full report.',
    'Update only action_required with report.publish({ slots: { action_required: "<html>" } }); scheduled full reports handle the other slots and wiki resync.',
    'Return a concise Korean reminder the owner can read at a glance, most urgent or nearest deadline first, under a short Korean title that names the top priorities.',
  ].join('\n'),
  'full-report': [
    'Call source.recent for changes since the supplied prior full-report time, work.list with view="pipeline", and schedule.upcoming with days=14.',
    'Read originals with source.read when a recent line changes the report; distinguish an empty result from failed or stale collection.',
    'Compare every open deadline with the event and holiday calendar; use event end times when deciding whether a booking overlaps.',
    'Name work items under each stage. List every item waiting on an owner decision, with the decision requested.',
    'Say plainly when there were no changes. Include the owner schedule section and list its upcoming events and holidays.',
    'Publish all four board sections with report.publish before writing the text report.',
    'After publishing the board, update each changed topic wiki page as a resync with manage.wiki.update, creating one with manage.wiki.publish only when no topic page fits. Write the daily/YYYY-MM-DD.md journal grouped by project with one entry per moved item, and put lessons under lessons/.',
    'Write the Korean report in five parts, in order: key situation today; needs a response; needs a decision; pipeline with each stage and item; next actions. Put the owner schedule and holidays under key situation today.',
  ].join('\n'),
  'owner-answer': [
    'Answer owner questions from what this session already knows. Read only what is needed to confirm a fact or learn something not yet known.',
    'An owner-requested report is text. Publish the board only when the owner turn changed work.',
    'Keep the answer concise, with no working notes, narration about answering, or record or observation ids.',
  ].join('\n'),
};

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

export function renderLaneInstructions(
  lane: OwnerLane,
  entries: readonly GuidanceEntry[],
  backend: OwnerRuntimeBackend = 'codex',
  wikiEnabled = true,
  replay = false
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
  const recordId = record?.id ?? 'default';
  const instruction = record
    ? [record.summary, record.details ?? '', ...(record.steps ?? [])]
        .filter((line) => line.trim() !== '')
        .join('\n')
    : laneDefaults[lane];
  const routed = replay
    ? instruction
        .split('\n')
        .filter((line) => !line.includes('[notify]') && !line.includes('[ack]'))
        .join('\n')
    : instruction;
  const wikiFiltered = wikiEnabled
    ? routed
    : routed
        .split('\n')
        .filter(
          (line) =>
            !line.includes('manage.wiki.') &&
            !line.startsWith('When enabled,') &&
            !line.includes('topic wiki page')
        )
        .join('\n');
  const replace = (action: string): string => actionName(backend, action);
  const actionNames = [
    'work.list',
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
  const projected = actionNames.reduce(
    (text, action) => text.replaceAll(action, replace(action)),
    wikiFiltered
  );
  const replaces = record
    ? `, replaces=[{id: "${record.id}", reason: "the owner corrected this lane"}]`
    : '';
  return [
    `<lane-instructions lane="${lane}" record="${recordId}">`,
    projected,
    `Change this lane by saving a workflow with topic="lane/${lane}"${replaces} using ${replace('memory.save')}.`,
    '</lane-instructions>',
  ].join('\n');
}
