import type {
  Gateway,
  GatewayEvent,
  GatewayEventHandler,
  GatewayConfig,
  MessageSource,
} from './types.js';
import type { SessionDirectory, TurnIntake } from './turn-contract.js';
import type { TelegramFileDeliveryResult } from '../api/file-delivery.js';

export interface BaseGatewayOptions {
  intake: TurnIntake;
  sessionDirectory?: SessionDirectory;
  config?: Partial<GatewayConfig>;
}

export abstract class BaseGateway implements Gateway {
  abstract readonly source: MessageSource;

  protected readonly sessionDirectory?: SessionDirectory;
  protected readonly intake: TurnIntake;
  protected readonly eventHandlers: GatewayEventHandler[] = [];
  protected connected = false;

  constructor(options: BaseGatewayOptions) {
    this.sessionDirectory = options.sessionDirectory;
    this.intake = options.intake;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract sendMessage(channelId: string, text: string, idempotencyKey?: string): Promise<void>;
  abstract sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<TelegramFileDeliveryResult>;

  protected get mentionPattern(): RegExp | null {
    return null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onEvent(handler: GatewayEventHandler): void {
    this.eventHandlers.push(handler);
  }

  protected emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  protected cleanMessageContent(content: string): string {
    if (!this.mentionPattern) return content.trim();
    return content.replace(this.mentionPattern, '').trim();
  }
}
