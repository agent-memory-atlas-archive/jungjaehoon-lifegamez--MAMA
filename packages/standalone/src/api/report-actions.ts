/**
 * report.* action registrations — the owner-board artifact surface.
 *
 * §4.2: report.* is NOT moved into core. The existing slot store stays the
 * implementation; it reaches the shared catalog through this injected port the
 * same way the effects ledger reaches work.changes. The ports are late-bound:
 * the report store opens with the API server, after the catalog exists, so a
 * call that lands before route init fails loud instead of reading an unbound
 * store.
 */
import type { ActionRegistration } from '@jungjaehoon/mama-core';
import { readBoardView, type BoardSlots } from '../operator/board-read-views.js';
import {
  buildReportPublishToolContract,
  htmlUsesBoardVocabulary,
} from '../operator/board-slot-instructions.js';
import type { ReportPublishResult, ReportUpdateOptions } from './report-handler.js';

export type ReportPublisher = (
  slots: Record<string, string>,
  options?: ReportUpdateOptions
) => void | readonly string[] | ReportPublishResult;

export interface ReportPorts {
  publisher?: ReportPublisher | null;
  reader?: (() => BoardSlots) | null;
}

function isReportPublishResult(
  value: void | readonly string[] | ReportPublishResult
): value is ReportPublishResult {
  return value !== undefined && !Array.isArray(value);
}

/**
 * Host-side failure with a stable code. Dispatch maps a named error's `name`
 * to the result code — no core error class is imported, so module identity
 * across package boundaries can never split the contract.
 */
function reportFailure(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

export function reportActionRegistrations(ports: ReportPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'report.read',
        summary:
          'Read the owner dashboard report slots (briefing, action_required, decisions, pipeline) as a dated presentation snapshot, not a live operational count. Progressive: no slot lists descriptors (name, updatedAt, htmlLength, publishable); a named slot pages its text or stored html by Unicode code points (nextOffset/total keep a long slot fully reachable). A continuation (offset > 0) must echo the readVersion of the previous page.',
        inputSchema: {
          type: 'object',
          properties: {
            slot: { type: 'string', minLength: 1 },
            format: { enum: ['text', 'html'] },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 4000 },
            readVersion: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        examples: [
          { title: 'List slot descriptors', input: {} },
          { title: 'Read the briefing slot as text', input: { slot: 'briefing', format: 'text' } },
        ],
      },
      exec: (input) => {
        const reader = ports.reader;
        if (!reader) {
          throw reportFailure(
            'board_unavailable',
            'Report store not wired (report.read requires the API server report store).'
          );
        }
        return readBoardView(input, reader());
      },
    },
    {
      contract: {
        name: 'report.publish',
        recallableWrite: true,
        summary: buildReportPublishToolContract(),
        inputSchema: {
          type: 'object',
          properties: {
            slots: { type: 'object' },
            basis_revision: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
          },
          required: ['slots'],
          additionalProperties: false,
        },
        examples: [
          {
            title: 'Publish the briefing slot',
            input: {
              slots: {
                briefing:
                  '<div class="report-summary"><div class="summary-title">Today</div></div>',
              },
            },
          },
        ],
      },
      exec: (input, context) => {
        const { slots: slotsInput, basis_revision: basisRevision } = input as {
          slots: Record<string, unknown>;
          basis_revision?: string | null;
        };
        if (
          Object.keys(slotsInput).length === 0 ||
          Object.values(slotsInput).some((value) => typeof value !== 'string')
        ) {
          throw reportFailure(
            'invalid_slots',
            'report.publish slots must be a non-empty object of HTML strings'
          );
        }
        const slots = slotsInput as Record<string, string>;
        if (
          basisRevision !== undefined &&
          basisRevision !== null &&
          (typeof basisRevision !== 'string' ||
            !basisRevision.trim() ||
            basisRevision !== basisRevision.trim())
        ) {
          throw reportFailure(
            'invalid_basis_revision',
            'report.publish basis_revision must be a canonical task basis from report.read'
          );
        }
        const publisher = ports.publisher;
        if (!publisher) {
          throw reportFailure('publisher_unavailable', 'Report publisher not configured');
        }
        const publication = publisher(slots, {
          // An omitted basis means unknown freshness. Persist that state so a
          // same-HTML publish also clears a previously asserted basis.
          basisRevision: basisRevision ?? null,
          operationId: context.operationId ?? null,
          modelRunId: context.session?.modelRunId ?? null,
        });
        // Backward compatibility: older injected publishers return void or the
        // exact changed slot array. Production distinguishes slots accepted as
        // present from slots whose HTML actually changed.
        const acceptedSlotIds = Array.isArray(publication)
          ? [...new Set(publication)].sort()
          : isReportPublishResult(publication)
            ? [...new Set(publication.acceptedSlotIds)].sort()
            : Object.keys(slots).sort();
        const changedSlotIds = Array.isArray(publication)
          ? [...acceptedSlotIds]
          : isReportPublishResult(publication)
            ? [...new Set(publication.changedSlotIds)].sort()
            : [...acceptedSlotIds];
        if (acceptedSlotIds.length === 0) {
          throw reportFailure('publish_rejected', 'Report publisher accepted no slots');
        }

        // Observability, not enforcement: a board slot is a reversible durable
        // write, so HTML that misses the board class vocabulary is published as
        // supplied and reported back as a warning. Without this the slot
        // silently renders as unstyled plain text.
        const runLabel = context.session?.modelRunId ?? 'unknown';
        const vocabularyWarnings: string[] = [];
        for (const slotId of acceptedSlotIds) {
          const html = slots[slotId];
          if (typeof html !== 'string' || !html.trim()) continue;
          if (htmlUsesBoardVocabulary(html)) continue;
          vocabularyWarnings.push(
            `slot ${slotId} uses none of the board structural classes (report-summary / report-card / report-section-title / report-table) and will render as plain text; republish using the report.publish contract (tool_describe report.publish)`
          );
          console.warn(
            `[board] slot ${slotId} published without the board vocabulary (run ${runLabel})`
          );
        }

        return {
          success: true,
          acceptedSlotIds,
          changedSlotIds,
          message: `Dashboard report accepted: ${acceptedSlotIds.join(', ')} (${acceptedSlotIds.length} accepted, ${changedSlotIds.length} changed)`,
          ...(vocabularyWarnings.length > 0
            ? {
                warnings: vocabularyWarnings,
                // The shape and classes in hand once, not per slot, so the
                // republish needs no second lookup.
                contract: buildReportPublishToolContract(),
              }
            : {}),
        };
      },
    },
  ];
}
