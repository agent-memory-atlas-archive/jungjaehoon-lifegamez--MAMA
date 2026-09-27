import type { TelegramTextFormatting } from './telegram-text-entities.js';

export type { TelegramTextFormatting, TelegramTextEntity } from './telegram-text-entities.js';

export type MessageSource = 'discord' | 'slack' | 'telegram' | 'chatwork' | 'system';

export interface PrincipalContext {
  readonly class: 'owner';
  readonly lane: 'owner';
  readonly canonicalId: string;
  readonly principalId?: string;
  readonly consoleEligible: boolean;
}

export interface ContentBlock {
  type: 'text' | 'image' | 'document';
  text?: string;
  localPath?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface NormalizedMessage {
  source: MessageSource;
  channelId: string;
  channelName?: string;
  userId: string;
  text: string;
  principal?: PrincipalContext;
  contentBlocks?: ContentBlock[];
  metadata?: MessageMetadata;
}

export interface MessageAttachment {
  type: 'image' | 'file';
  filename: string;
  url?: string;
  sourceRef?: string;
  localPath?: string;
  contentType?: string;
  size?: number;
}

export interface MessageMetadata {
  messageId?: string;
  chatType?: string;
  username?: string;
  untrustedWrapped?: boolean;
  telegramFormatting?: TelegramTextFormatting;
}

export interface Session {
  id: string;
  source: MessageSource;
  channelId: string;
  channelName?: string;
  userId?: string;
  context: string;
  createdAt: number;
  lastActive: number;
}

export interface ConversationTurn {
  user: string;
  bot: string;
  timestamp?: number;
  sourceMessageRef?: string;
  sourceObservationRef?: string;
  resultObservationRef?: string;
  state?: 'provisional' | 'final' | 'shared';
  sharedReplyRef?: string;
  finalResponseSha256?: string;
}

export interface GatewayConfig {
  enabled: boolean;
}

export type GatewayEventType =
  | 'connected'
  | 'disconnected'
  | 'message_received'
  | 'message_sent'
  | 'error';

export interface GatewayEvent {
  type: GatewayEventType;
  source: MessageSource;
  timestamp: Date;
  data?: unknown;
  error?: Error;
}

export type GatewayEventHandler = (event: GatewayEvent) => void;

export interface Gateway {
  readonly source: MessageSource;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  onEvent(handler: GatewayEventHandler): void;
}
