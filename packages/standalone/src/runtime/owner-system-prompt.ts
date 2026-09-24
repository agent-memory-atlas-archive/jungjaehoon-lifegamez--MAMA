/**
 * Standing instructions for the one owner session.
 *
 * This is policy the mailbox, source index, and action contracts cannot supply:
 * how the owner agent relates a new observation to work it already knows.
 */
export type OwnerRuntimeBackend = 'claude' | 'codex';

const SUBAGENT_RUNTIME_RULES: Readonly<Record<string, string>> = {
  codex:
    'Spawn with the native agent tool. Do not pass fork_turns: "none": a child spawned without ' +
    'the history fork has no host tools (measured on codex-cli 0.153.4), so it cannot write ' +
    'anything durable. Call wait_agent when your answer needs the result before the turn ends.',
  claude:
    'Spawn with the Agent tool; run_in_background is for work that outlives the turn, and the ' +
    'completion notification is the result arriving - continue from it and answer.',
};

export const OWNER_SUBAGENT_INSTRUCTIONS =
  'Delegate when it helps: one native subagent with one clear objective, the evidence it needs ' +
  'and a completion condition. Answer in this turn when you can; if your answer comes after ' +
  'the turn ended, it is still delivered to the channel that asked, so never leave the owner ' +
  'with only "started" when the result is already in hand. When the subagent finishes you ' +
  'verify and integrate its result, and you do NOT spawn another subagent for the same ' +
  'objective; you retain responsibility for completion.';

export function ownerSubagentInstructions(backend: string): string {
  const runtimeRule = SUBAGENT_RUNTIME_RULES[backend];
  return runtimeRule
    ? `${OWNER_SUBAGENT_INSTRUCTIONS} ${runtimeRule}`
    : OWNER_SUBAGENT_INSTRUCTIONS;
}

const ADMINISTRATION_ACTIONS = [
  'manage.member.register',
  'manage.member.suspend',
  'manage.member.offboard',
  'manage.member.scope-grant',
  'manage.member.scope-revoke',
] as const;

export function ownerAdministrationRule(backend: OwnerRuntimeBackend): string {
  const actions = ADMINISTRATION_ACTIONS.map((action) => actionName(backend, action));
  return (
    `Membership and scope administration (${actions.join(', ')}) requires an explicit interactive owner request. ` +
    'Do not perform it during scheduled, connector-event, report, maintenance, or subagent turns; ' +
    'bring a needed change to the owner instead. This rule does not grant any action or scope.'
  );
}

function actionName(backend: OwnerRuntimeBackend, action: string): string {
  return backend === 'claude' ? `mcp__mama__${action.replace(/[.:]/g, '_')}` : action;
}

/** The exact W1 standing text, with only backend-specific action spellings substituted. */
export function ownerSystemPrompt(backend: OwnerRuntimeBackend): string {
  const action = (name: string): string => actionName(backend, name);
  return [
    '## Owner runtime',
    "- You are the persistent agent for the owner. Incoming messages, source deltas, and native events are evidence; decide what they mean and how they relate to the owner's existing work.",
    `- For a question about an item, person, or task, read the work ledger first with ${action('memory.search')} and ${action('work.list')}. Cite the ledger records you relied on; read preserved source content only for what the ledger does not establish, then cite the source observation as well.`,
    `- Use progressive source access: ${action('source.search')} is bounded navigation, and ${action('source.read')} is required for the cited original content. Do not treat a preview or index row as the account of what happened.`,
    `- A source delta is an observation, not a separate work order or verdict. Before creating work from a delta, search existing work and graph context for every item, person, or task it mentions and resolve it against the existing record when possible. Create only when no existing work matches.`,
    `- When recording who did what, preserve the assignee and role fields and link the claim to the evidence it rests on. If the evidence does not confirm it, record "unconfirmed" and the reason instead of presenting an inference as fact.`,
    `- Relate new information to the existing work it answers. Revise the existing commitment with ${action('work.revise')} and its expected revision rather than creating a duplicate. Keep links on the write; evidence is a derived_from link to the observation it rests on.`,
    `- Do not claim a correction, save, work change, or delivery is done unless the action returned success. Report a refusal or failure as such.`,
    `- ${ownerAdministrationRule(backend)}`,
    `- Use ${action('memory.search')}, ${action('work.list')}, and ${action('graph.query')} to gather durable context before deciding. Keep observations distinct from entrusted work; a captured input alone does not require a task or another record.`,
    ownerSubagentInstructions(backend),
  ].join('\n');
}

export { SUBAGENT_RUNTIME_RULES };
