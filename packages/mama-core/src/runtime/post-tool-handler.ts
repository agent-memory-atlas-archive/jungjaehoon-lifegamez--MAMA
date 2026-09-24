/**
 * After a tool runs, turn what it wrote into memory records, bounded and deduplicated,
 * and fire-and-forget.
 *
 * What is here is the mechanism: notice that an editing tool ran, find the file it
 * touched and the content it produced, ask for candidate records, keep at most a
 * stated number of them, skip the ones already stored, and write the rest. What a
 * candidate *is* is not here. A candidate is vocabulary, and vocabulary belongs to
 * the caller: it supplies the source, and it names the two tools this handler calls.
 *
 * With no source, the handler is inert. That is the intended resting state once the
 * caller's own extractor is gone.
 */

/** A record the caller wants written when a tool's output yields one. */
export interface PostToolMemoryCandidate {
  topic: string;
  decision: string;
  reasoning: string;
  confidence: number;
}

/**
 * The only thing this handler reads off the caller's execution context: somewhere to
 * register the background task it starts, so the turn that produced the tool result
 * can wait for the write instead of racing it.
 */
export interface PostToolExecutionContext {
  backgroundTasks?: { register(task: Promise<unknown>): void } | null;
}

/** Where candidates come from. The caller owns every judgment this makes. */
export interface PostToolMemorySource {
  /**
   * Candidates this content yields. Return an empty array when the content, the
   * path, or the caller's own rules say nothing should be written.
   */
  candidates(content: string, filePath: string): readonly PostToolMemoryCandidate[];
}

export interface PostToolHandlerConfig {
  enabled: boolean;
  /** Tool names whose output is read. A tool matches when its name contains one of these. */
  editTools: readonly string[];
  /** The tool this handler calls to look for an existing record. */
  searchTool: string;
  /** The tool this handler calls to write one. */
  saveTool: string;
  /** At most this many candidates are written per tool result. */
  saveLimit?: number;
}

const DEFAULT_SAVE_LIMIT = 20;

type ExecuteToolFn<Ctx> = (
  name: string,
  input: Record<string, unknown>,
  executionContext?: Ctx | null
) => Promise<unknown>;

interface SearchResultItem {
  topic?: string;
  decision?: string;
  similarity?: number;
}

interface SearchResponse {
  results?: SearchResultItem[];
}

export class PostToolHandler<Ctx extends PostToolExecutionContext = PostToolExecutionContext> {
  private readonly executeTool: ExecuteToolFn<Ctx>;
  private readonly enabled: boolean;
  private readonly editTools: readonly string[];
  private readonly searchTool: string;
  private readonly saveTool: string;
  private readonly saveLimit: number;
  private readonly source: PostToolMemorySource | null;

  constructor(
    executeTool: ExecuteToolFn<Ctx>,
    config: PostToolHandlerConfig,
    source: PostToolMemorySource | null = null
  ) {
    this.executeTool = executeTool;
    this.enabled = config.enabled;
    this.editTools = config.editTools;
    this.searchTool = config.searchTool;
    this.saveTool = config.saveTool;
    this.saveLimit = config.saveLimit ?? DEFAULT_SAVE_LIMIT;
    this.source = source;
  }

  /**
   * Called from the tool-result path. MUST NOT be async, MUST NOT return a promise
   * and MUST NOT throw: a memory write is not allowed to decide whether a turn
   * continues. The task is registered so the turn can still wait for it.
   */
  processInBackground(
    toolName: string,
    input: unknown,
    result: unknown,
    executionContext?: Ctx | null
  ): void {
    if (!this.enabled || !this.source) {
      return;
    }
    const task = this.processAsync(toolName, input, result, executionContext);
    executionContext?.backgroundTasks?.register(task);
    void task.catch(() => {});
  }

  private async processAsync(
    toolName: string,
    input: unknown,
    result: unknown,
    executionContext?: Ctx | null
  ): Promise<void> {
    if (!this.enabled || !this.source) {
      return;
    }

    if (!this.isEditTool(toolName)) {
      return;
    }

    const filePath = this.extractFilePath(input);
    if (!filePath) {
      return;
    }

    const content = this.extractContent(result);
    if (!content) {
      return;
    }

    const candidates = this.source.candidates(content, filePath);
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates.slice(0, this.saveLimit)) {
      const isDupe = await this.isDuplicate(candidate, executionContext);
      if (isDupe) {
        continue;
      }
      await this.save(candidate, executionContext);
    }
  }

  private isEditTool(toolName: string): boolean {
    return this.editTools.some((tool) => toolName.includes(tool));
  }

  private extractFilePath(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }
    const obj = input as Record<string, unknown>;
    const raw = obj['path'] ?? obj['file_path'] ?? obj['filePath'];
    return typeof raw === 'string' ? raw : undefined;
  }

  private extractContent(result: unknown): string | undefined {
    if (typeof result === 'string') {
      return result.length > 0 ? result : undefined;
    }
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (typeof obj['content'] === 'string' && obj['content'].length > 0) {
        return obj['content'];
      }
      const serialized = JSON.stringify(result);
      return serialized.length > 2 ? serialized : undefined;
    }
    return undefined;
  }

  private async isDuplicate(
    candidate: PostToolMemoryCandidate,
    executionContext?: Ctx | null
  ): Promise<boolean> {
    try {
      const input = { query: candidate.topic, type: 'decision', limit: 3 };
      const response = (await (executionContext
        ? this.executeTool(this.searchTool, input, executionContext)
        : this.executeTool(this.searchTool, input))) as SearchResponse | undefined;

      if (!response?.results || response.results.length === 0) {
        return false;
      }
      return response.results.some(
        (item) => item.topic === candidate.topic && item.decision === candidate.decision
      );
    } catch {
      return false;
    }
  }

  private async save(
    candidate: PostToolMemoryCandidate,
    executionContext?: Ctx | null
  ): Promise<void> {
    try {
      const input = {
        type: 'decision',
        topic: candidate.topic,
        decision: candidate.decision,
        reasoning: candidate.reasoning,
        confidence: candidate.confidence,
      };
      if (executionContext) {
        await this.executeTool(this.saveTool, input, executionContext);
      } else {
        await this.executeTool(this.saveTool, input);
      }
    } catch {
      // A memory write that fails must not fail the turn that produced it.
    }
  }
}
