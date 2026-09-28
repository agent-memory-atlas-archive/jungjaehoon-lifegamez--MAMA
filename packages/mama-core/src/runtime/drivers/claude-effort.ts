export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The `--effort` arguments for a Claude model; none when the model takes no effort setting. */
export function claudeEffortArgs(
  model: string | undefined,
  effort: ThinkingEffort | undefined
): string[] {
  // --effort: Opus/Sonnet 4.6, Opus 4.7/4.8, and the Claude 5 family (Opus, Sonnet, Fable, Mythos).
  if (
    !model ||
    !effort ||
    !/^claude-(?:(?:opus|sonnet)-4-6|opus-4-[78]|(?:opus|sonnet|fable|mythos)-5)(?:\b|-)/.test(
      model
    )
  ) {
    return [];
  }
  // xhigh arrived with Opus 4.7; the 4.6 models take low through max.
  const accepted =
    effort === 'xhigh' && /^claude-(?:opus|sonnet)-4-6(?:\b|-)/.test(model) ? 'high' : effort;
  return ['--effort', accepted];
}
