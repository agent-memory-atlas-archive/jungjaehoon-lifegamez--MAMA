import type { NormalizedItem } from '../../storage/source-archive.js';

export type { NormalizedItem } from '../../storage/source-archive.js';

export interface ChannelConfig {
  role: 'truth' | 'hub' | 'deliverable' | 'spoke' | 'reference' | 'ignore';
  name?: string;
  boardId?: string;
}

export interface AuthConfig {
  type: 'token' | 'none';
  tokenName?: string;
}

export interface AuthRequirement {
  type: 'token' | 'none';
  tokenName?: string;
  description: string;
}

export interface ConnectorConfig {
  enabled: boolean;
  pollIntervalMinutes: number;
  channels: Record<string, ChannelConfig>;
  auth: AuthConfig;
}

export interface ConnectorHealth {
  healthy: boolean;
  lastPollTime: Date | null;
  lastPollCount: number;
  error?: string;
}

export interface IConnector {
  name: string;
  type: 'api' | 'local';
  init(): Promise<void>;
  dispose(): Promise<void>;
  healthCheck(): Promise<ConnectorHealth>;
  getAuthRequirements(): AuthRequirement[];
  authenticate(): Promise<boolean>;
  beginPollHandoff?(): void;
  poll(since: Date): Promise<NormalizedItem[]>;
  commitPoll?(): void | Promise<void>;
  abortPollHandoff?(): void;
}

export type ConnectorsConfig = Record<string, ConnectorConfig>;
