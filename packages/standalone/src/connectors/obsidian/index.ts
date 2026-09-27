/**
 * ObsidianConnector — polls an Obsidian vault by scanning *.md files on the local filesystem.
 * Uses statSync for mtime checks and readFileSync for content.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

export class ObsidianConnector implements IConnector {
  readonly name = 'obsidian';
  readonly type = 'local' as const;

  private config: ConnectorConfig;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined = undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const configured = this.getVaultConfigs();
    if (configured.length === 0) {
      throw new Error('Obsidian vault path not configured. Set vaultPath in channel config.');
    }
    for (const { channelKey, vaultPath } of configured) {
      try {
        if (!statSync(vaultPath).isDirectory()) throw new Error('path is not a directory');
        readdirSync(vaultPath);
      } catch (error) {
        throw new Error(`Obsidian vault for channel ${channelKey} is not readable: ${vaultPath}`, {
          cause: error,
        });
      }
    }
  }

  async dispose(): Promise<void> {
    // No resources to clean up
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'none',
        description: 'No authentication required. Configure vaultPath in channel settings.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      const configured = this.getVaultConfigs();
      if (configured.length === 0) return false;
      for (const { vaultPath } of configured) {
        if (!statSync(vaultPath).isDirectory()) return false;
        readdirSync(vaultPath);
      }
      return true;
    } catch {
      return false;
    }
  }

  private getVaultConfigs(): Array<{ channelKey: string; vaultPath: string }> {
    return Object.entries(this.config.channels)
      .filter(([, channel]) => channel.role !== 'ignore')
      .map(([channelKey, channel]) => {
        if (!channel.vaultPath) {
          throw new Error(`Obsidian channel ${channelKey} requires vaultPath`);
        }
        return { channelKey, vaultPath: channel.vaultPath };
      });
  }

  private collectMdFiles(dir: string): string[] {
    const results: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden directories (e.g., .obsidian, .git)
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.collectMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    const items: NormalizedItem[] = [];
    const configured = this.getVaultConfigs();
    let failedVaults = 0;
    let lastVaultError: string | undefined;
    for (const { channelKey, vaultPath } of configured) {
      try {
        for (const filePath of this.collectMdFiles(vaultPath)) {
          const stat = statSync(filePath);
          if (stat.mtime <= since) continue;

          const relPath = relative(vaultPath, filePath);
          const content = readFileSync(filePath, 'utf8');
          items.push({
            source: 'obsidian',
            sourceId: `${channelKey}:${relPath}`,
            sourceEntityId: `${channelKey}:${relPath}`,
            channel: channelKey,
            author: '',
            content,
            timestamp: stat.mtime,
            type: 'note',
            metadata: {
              relPath,
              mtime: stat.mtime.toISOString(),
            },
          });
        }
      } catch (error) {
        failedVaults += 1;
        lastVaultError = error instanceof Error ? error.message : String(error);
      }
    }

    if (failedVaults > 0) {
      this.lastError = `Obsidian poll failed for ${failedVaults} of ${configured.length} configured vault paths; last error: ${lastVaultError}`;
      this.lastPollTime = new Date();
      this.lastPollCount = items.length;
      throw new Error(this.lastError);
    }
    items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;
    return items;
  }
}
