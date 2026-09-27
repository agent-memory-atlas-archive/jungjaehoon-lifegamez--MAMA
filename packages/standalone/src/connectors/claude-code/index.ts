/**
 * ClaudeCodeConnector — reads conversation history from Claude Code's JSONL files.
 * Polls ~/.claude/projects/<project-dir>/*.jsonl for user and assistant messages
 * newer than the given timestamp.
 *
 * Each JSONL file is one session. Messages have types: user, assistant, system, etc.
 * We extract user + assistant messages as conversation items.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface JsonlMessage {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
  sessionId?: string;
}

export class ClaudeCodeConnector implements IConnector {
  readonly name = 'claude-code';
  readonly type = 'local' as const;

  private basePath: string;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(
    private config: ConnectorConfig,
    basePath?: string
  ) {
    this.basePath = basePath ?? join(homedir(), '.claude', 'projects');
  }

  async init(): Promise<void> {
    try {
      readdirSync(this.basePath);
    } catch {
      throw new Error(`ClaudeCodeConnector: cannot read ${this.basePath}`);
    }
    const projects = Object.entries(this.config.channels).filter(
      ([, channel]) => channel.role !== 'ignore'
    );
    if (projects.length === 0) {
      throw new Error('Claude Code requires explicitly selected project directories');
    }
    const aliases = projects.map(([, channel]) => channel.name?.trim() ?? '');
    if (aliases.some((alias) => alias === '') || new Set(aliases).size !== aliases.length) {
      throw new Error('Claude Code selected projects require unique configured display aliases');
    }
    for (const [projectDir] of projects) {
      if (
        projectDir === '.' ||
        projectDir === '..' ||
        basename(projectDir) !== projectDir ||
        projectDir.includes('/') ||
        projectDir.includes('\\')
      ) {
        throw new Error('Claude Code project selection must use project directory names');
      }
      try {
        readdirSync(join(this.basePath, projectDir));
      } catch (error) {
        throw new Error(`Claude Code selected project ${projectDir} is not readable`, {
          cause: error,
        });
      }
    }
  }

  async dispose(): Promise<void> {
    // No resources to clean up
  }

  async healthCheck(): Promise<ConnectorHealth> {
    let healthy = false;
    try {
      readdirSync(this.basePath);
      healthy = true;
    } catch {
      // basePath not accessible
    }
    return {
      healthy: healthy && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'none',
        description: 'No authentication required. Reads local Claude Code conversation files.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      const projects = Object.entries(this.config.channels).filter(
        ([, channel]) => channel.role !== 'ignore'
      );
      if (projects.length === 0) return false;
      const aliases = projects.map(([, channel]) => channel.name?.trim() ?? '');
      if (aliases.some((alias) => alias === '') || new Set(aliases).size !== aliases.length) {
        return false;
      }
      for (const [projectDir] of projects) readdirSync(join(this.basePath, projectDir));
      return true;
    } catch {
      return false;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];
    const sinceMs = since.getTime();
    const projects = Object.entries(this.config.channels).filter(
      ([, channel]) => channel.role !== 'ignore'
    );
    let failedProjects = 0;
    let lastProjectError: string | undefined;
    for (const [projectDir, channelConfig] of projects) {
      const alias = channelConfig.name;
      if (!alias) throw new Error(`Claude Code project ${projectDir} has no display alias`);
      try {
        const fullPath = join(this.basePath, projectDir);
        const sessionFiles = readdirSync(fullPath).filter((f) => f.endsWith('.jsonl'));

        for (const file of sessionFiles) {
          const filePath = join(fullPath, file);
          const stat = statSync(filePath);
          // Skip files not modified since last poll
          if (stat.mtimeMs < sinceMs) continue;

          const sessionId = basename(file, '.jsonl');
          const messages = this.parseJsonl(filePath, sinceMs);

          for (const msg of messages) {
            items.push({
              source: 'claude-code',
              sourceId: `claude-code:${alias}:${sessionId}:${msg.timestamp}:${msg.messageIndex}`,
              sourceEntityId: `${alias}:${sessionId}`,
              channel: alias,
              author: msg.role === 'user' ? 'user' : 'claude',
              content: msg.content,
              timestamp: new Date(msg.timestamp),
              type: 'message',
              metadata: {
                sessionId,
                role: msg.role,
                projectAlias: alias,
              },
            });
          }
        }
      } catch (error) {
        failedProjects += 1;
        lastProjectError = error instanceof Error ? error.message : String(error);
      }
    }

    if (failedProjects > 0) {
      this.lastError = `Claude Code poll failed for ${failedProjects} of ${projects.length} configured project directories; last error: ${lastProjectError}`;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      throw new Error(this.lastError);
    }
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;
    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return items;
  }

  private parseJsonl(
    filePath: string,
    sinceMs: number
  ): Array<{ role: string; content: string; timestamp: number; messageIndex: number }> {
    const results: Array<{
      role: string;
      content: string;
      timestamp: number;
      messageIndex: number;
    }> = [];
    const raw = readFileSync(filePath, 'utf-8');

    const lines = raw.split('\n');
    if (!raw.endsWith('\n')) lines.pop();
    for (const [messageIndex, line] of lines.entries()) {
      if (!line.trim()) continue;
      let msg: JsonlMessage;
      try {
        msg = JSON.parse(line);
      } catch (error) {
        throw new Error(`Claude Code JSONL contains malformed JSON in ${basename(filePath)}`, {
          cause: error,
        });
      }

      // Only extract user and assistant messages
      if (msg.type !== 'user' && msg.type !== 'assistant') continue;

      const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
      if (ts <= sinceMs) continue;

      let content = '';
      const msgContent = msg.message?.content;
      if (typeof msgContent === 'string') {
        content = msgContent;
      } else if (Array.isArray(msgContent)) {
        content = msgContent
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n');
      }

      // Skip empty or hook/system messages; keep the full user and assistant text.
      if (!content) continue;
      // Skip hook/system messages
      if (content.startsWith('<command-message>') || content.startsWith('<system-reminder>'))
        continue;

      const role = msg.type === 'user' ? 'user' : 'assistant';
      results.push({ role, content, timestamp: ts, messageIndex });
    }

    return results;
  }
}
