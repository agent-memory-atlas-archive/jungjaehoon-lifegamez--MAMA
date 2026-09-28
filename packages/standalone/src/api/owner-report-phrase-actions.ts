import type { ActionContext, ActionRegistration } from '@jungjaehoon/mama-core';
import { phraseKey, type ReportPhraseSetting } from '../runtime/report-phrases.js';

export interface OwnerReportPhraseActionPorts {
  ownerPrincipalId: string;
  setting: ReportPhraseSetting;
  isOwnerMessageTurn(sourceMessageRef: string): boolean;
  /** The full report turn for the owner message being answered, so it is applied in that turn. */
  fullReportTurn(sourceMessageRef: string): string;
}

function denied(): Error {
  const error = new Error('owner.report_phrases.set is available only in an owner message turn');
  error.name = 'denied';
  return error;
}

function phraseList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((phrase) => typeof phrase === 'string' && phrase.trim())
  )
    throw Object.assign(new Error(`${field} must be a list of nonblank words`), {
      name: 'invalid_input',
    });
  return value.map((phrase: string) => phrase.trim());
}

export function ownerReportPhraseActionRegistrations(
  ports: OwnerReportPhraseActionPorts
): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'owner.report_phrases.set',
        summary:
          'Add or remove the words that bring the full report when the owner writes them in chat. Allowed only in a turn that answers an owner message; source-delta, scheduled and replay turns and non-owner callers are denied. A call with nothing to add or remove changes nothing. Returns the registered words before and after, and the full report steps to follow when the owner asked for the report in this message.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            add: { type: 'array', items: { type: 'string', minLength: 1 } },
            remove: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
        examples: [{ title: 'Register a report request', input: { add: ['full report'] } }],
      },
      exec: (input, context: ActionContext) => {
        if (context.access.principalId !== ports.ownerPrincipalId) throw denied();
        if (context.session?.replaySourceEndMs !== undefined) throw denied();
        const sourceMessageRef = context.session?.sourceMessageRef;
        if (!sourceMessageRef || !ports.isOwnerMessageTurn(sourceMessageRef)) throw denied();
        const request = input as { add?: unknown; remove?: unknown };
        const add = phraseList(request.add, 'add');
        const remove = new Set(phraseList(request.remove, 'remove').map(phraseKey));
        const previous = [...ports.setting.get()];
        const kept = new Map<string, string>();
        for (const phrase of [...previous, ...add]) {
          const key = phraseKey(phrase);
          if (!remove.has(key) && !kept.has(key)) kept.set(key, phrase);
        }
        const phrases = [...kept.values()];
        if (add.length > 0 || remove.size > 0) ports.setting.set(phrases);
        return { phrases, previous, reportSteps: ports.fullReportTurn(sourceMessageRef) };
      },
    },
  ];
}
