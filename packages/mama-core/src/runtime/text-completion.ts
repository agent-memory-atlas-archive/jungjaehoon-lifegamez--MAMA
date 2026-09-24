/**
 * The one model the runtime opens, as the shape a caller may ask it for text.
 *
 * `memory/api.ts` reached a local Ollama endpoint directly when a search asked
 * for LLM reranking: a second place opening a model, decided inside the
 * library rather than by whoever runs it (§2.1 — one place opens the model).
 *
 * A runner is stated by the host that starts the runtime and reaches an action
 * through the catalog. A host that states none has no model for this, which is
 * exactly what a host whose model is unreachable already had: the call falls
 * back to the ranking it already computed and says so.
 */
export interface TextCompletionOptions {
  /** 'json' asks the model to answer with JSON and nothing else. */
  format?: 'json' | 'text';
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Ask the runtime's model for one completion. Rejects rather than answering falsely. */
export type TextCompletion = (prompt: string, options?: TextCompletionOptions) => Promise<string>;
