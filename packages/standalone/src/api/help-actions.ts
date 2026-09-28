import type { ActionContract, ActionRegistration } from '@jungjaehoon/mama-core';

/**
 * The first sentence of an action's summary: what every turn shows for it. The full contract is
 * one `help` call away, as Kagemusha keeps a one-line catalog and serves detail through `help()`.
 */
export function actionCatalogLine(summary: string): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const first = end === -1 ? flat : flat.slice(0, end + 1);
  return first.length <= 160 ? first : `${first.slice(0, 157)}...`;
}

function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'invalid_input';
  return error;
}

export interface HelpActionPorts {
  /** The granted contracts, read when `help` runs so it sees the finished catalog. */
  contracts(): readonly ActionContract[];
}

export function helpActionRegistrations(ports: HelpActionPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'help',
        summary:
          "Read actions' full contracts (summary, input schema, examples) before first use; with no names, list every action with its one-line summary.",
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            actions: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
        },
        examples: [
          { title: 'Read two contracts', input: { actions: ['work.list', 'report.publish'] } },
        ],
      },
      exec: (input) => {
        const requested = (input as { actions?: unknown }).actions;
        const contracts = ports.contracts();
        if (requested === undefined)
          return {
            actions: contracts.map((contract) => ({
              name: contract.name,
              summary: actionCatalogLine(contract.summary),
            })),
          };
        if (!Array.isArray(requested)) throw invalidInput('actions must be a list of action names');
        const byName = new Map(contracts.map((contract) => [contract.name, contract]));
        const unknown = requested.filter((name) => !byName.has(String(name)));
        if (unknown.length > 0) throw invalidInput(`unknown actions: ${unknown.join(', ')}`);
        return {
          actions: requested.map((name) => {
            const contract = byName.get(String(name))!;
            return {
              name: contract.name,
              summary: contract.summary,
              inputSchema: contract.inputSchema,
              ...(contract.examples === undefined ? {} : { examples: contract.examples }),
            };
          }),
        };
      },
    },
  ];
}
