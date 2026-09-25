import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { Bot } from 'grammy';
import type { Context } from 'grammy';
import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { BaseGateway } from './base-gateway.js';
import type { OwnerMessageInput, TurnIntake } from './turn-contract.js';
import {
  captureTelegramTextFormatting,
  selectTelegramTextEntities,
} from './telegram-text-entities.js';
import {
  formatTelegramMessage,
  isTelegramEntityRejection,
  type TelegramFormattedText,
} from './telegram-format.js';
import {
  TelegramMessageLedger,
  type TelegramMessageLedgerEntry,
} from './telegram-message-ledger.js';
import { TelegramResponsePresenter } from './telegram-response-presenter.js';

const TELEGRAM_MAX_LENGTH = 4096;
const MESSAGE_DEDUP_TTL_MS = 60_000;
const INTERRUPTED_RESPONSE =
  'The previous processing attempt was interrupted. It was not rerun because its external ' +
  'side effects could not be proven safe to repeat. Please send a new message if you want to ' +
  'retry it.';

type TelegramMessage = NonNullable<Context['message']>;
type TelegramApi = Bot['api'];
type SendMessageOther = Parameters<TelegramApi['sendMessage']>[2];
type EditMessageTextOther = Parameters<TelegramApi['editMessageText']>[3];

export interface TelegramGatewayConfig {
  enabled: boolean;
  allowedChats?: string[];
  ownerUserIds?: string[];
  polling?: boolean;
}

export interface TelegramGatewayOptions {
  token: string;
  intake: TurnIntake;
  config?: Partial<TelegramGatewayConfig>;
  messageLedgerPath?: string;
}

function entityOptions<T>(entities: TelegramFormattedText['entities']): T {
  return { entities } as unknown as T;
}

function telegramErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendErrorIsEntityOnly(error: unknown): boolean {
  return isTelegramEntityRejection(telegramErrorMessage(error));
}

async function sendFormattedMessage(
  api: TelegramApi,
  chatId: number,
  message: TelegramFormattedText
): Promise<{ message_id: number }> {
  if (message.entities.length === 0) return api.sendMessage(chatId, message.text);
  try {
    return await api.sendMessage(
      chatId,
      message.text,
      entityOptions<SendMessageOther>(message.entities)
    );
  } catch (error) {
    if (!sendErrorIsEntityOnly(error)) throw error;
    return api.sendMessage(chatId, message.text);
  }
}

async function editFormattedMessage(
  api: TelegramApi,
  chatId: number,
  messageId: number,
  message: TelegramFormattedText
): Promise<void> {
  if (message.entities.length === 0) {
    await api.editMessageText(chatId, messageId, message.text);
    return;
  }
  try {
    await api.editMessageText(
      chatId,
      messageId,
      message.text,
      entityOptions<EditMessageTextOther>(message.entities)
    );
  } catch (error) {
    if (!sendErrorIsEntityOnly(error)) throw error;
    await api.editMessageText(chatId, messageId, message.text);
  }
}

function sourceMessageRef(chatId: string, messageId: number): string {
  return `telegram:${chatId}:${messageId}`;
}

function chatIdFromSourceMessageRef(value: string): string {
  const prefix = 'telegram:';
  if (!value.startsWith(prefix)) throw new Error('Telegram source message reference is invalid');
  const rest = value.slice(prefix.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0 || !/^\d+$/.test(rest.slice(separator + 1))) {
    throw new Error('Telegram source message reference is invalid');
  }
  return rest.slice(0, separator);
}

function outboundLedgerKey(idempotencyKey: string): string {
  return `outbound:${createHash('sha256').update(`text\0${idempotencyKey}`).digest('hex')}`;
}

function payloadForFormatting(
  formatting: ReturnType<typeof captureTelegramTextFormatting>
): JsonValue | undefined {
  return formatting === undefined
    ? undefined
    : ({ telegramFormatting: formatting } as unknown as JsonValue);
}

/** Telegram owner ingress and its durable response transport. */
export class TelegramGateway extends BaseGateway {
  readonly source = 'telegram' as const;

  private readonly token: string;
  private readonly config: TelegramGatewayConfig;
  private readonly messageLedger: TelegramMessageLedger;
  private readonly chatTails = new Map<string, Promise<void>>();
  private readonly activePresenters = new Map<string, TelegramResponsePresenter>();
  private readonly recentMessageIds = new Map<string, number>();
  private readonly activeChat = new AsyncLocalStorage<{ chatId: string; active: boolean }>();
  private bot: Bot | null = null;
  private lastError: string | null = null;
  private lastMessageAt: number | undefined;

  protected get mentionPattern(): RegExp | null {
    return null;
  }

  constructor(options: TelegramGatewayOptions) {
    super({ intake: options.intake });
    this.token = options.token;
    this.config = {
      enabled: options.config?.enabled ?? true,
      allowedChats: options.config?.allowedChats ?? [],
      ...(options.config?.ownerUserIds === undefined
        ? {}
        : { ownerUserIds: options.config.ownerUserIds }),
      ...(options.config?.polling === undefined ? {} : { polling: options.config.polling }),
    };
    const ledgerPath = options.messageLedgerPath ?? process.env.MAMA_TELEGRAM_MESSAGE_LEDGER_PATH;
    if (!ledgerPath?.trim()) {
      throw new Error('Telegram message ledger path is required');
    }
    this.messageLedger = new TelegramMessageLedger(ledgerPath, {
      log: (line) => console.error(line),
    });
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (!this.config.allowedChats?.some((chatId) => chatId.trim().length > 0)) {
      throw new Error('telegram gateway disabled: allowed_chats is not set. Run: mama status');
    }
    if (!this.token.trim()) throw new Error('telegram gateway requires a token');

    try {
      this.bot = new Bot(this.token);
      this.bot.on('message', async (ctx: Context) => {
        if (ctx.message) await this.handleMessage(ctx.message);
      });
      this.bot.catch((error) => {
        this.lastError = telegramErrorMessage(error);
        console.error(`telegram handler failed error=${this.lastError}`);
      });
      await this.bot.init();
      this.connected = true;
      this.lastError = null;
      this.emitEvent({ type: 'connected', source: 'telegram', timestamp: new Date() });
      await this.recoverPendingResponses();
      if (this.config.polling !== false) {
        // Polling runs for the life of the process; a failure here means no owner message
        // is ever received, so it is logged, not swallowed.
        this.bot.start().catch((error: unknown) => {
          this.lastError = telegramErrorMessage(error);
          this.connected = false;
          console.error(`telegram polling stopped error=${this.lastError}`);
        });
        console.log(`telegram polling started polling=${this.config.polling ?? 'default'}`);
      } else {
        console.log('telegram polling disabled by config');
      }
    } catch (error) {
      this.lastError = telegramErrorMessage(error);
      if (this.bot) await this.bot.stop().catch(() => {});
      this.bot = null;
      this.connected = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.bot) await this.bot.stop().catch(() => {});
    this.bot = null;
    this.connected = false;
    this.recentMessageIds.clear();
    this.emitEvent({ type: 'disconnected', source: 'telegram', timestamp: new Date() });
  }

  /** Final response callback used by the owner runtime after a native turn settles. */
  async deliverResponse(sourceRef: string, response: string): Promise<void> {
    const chatId = chatIdFromSourceMessageRef(sourceRef);
    this.requireAllowedChat(chatId);
    const existing = this.messageLedger.get(sourceRef);
    if (!existing) throw new Error(`Telegram response has no accepted message ${sourceRef}`);
    if (existing.state === 'delivered') return;
    if (existing.state === 'ready' && existing.response !== response) {
      throw new Error('Telegram response conflicts with its durable ledger entry');
    }
    if (existing.state === 'processing')
      this.messageLedger.markReady(sourceRef, response, 'html-v1');
    if (!this.bot || !this.connected) return;
    await this.deliverReadyEntry(sourceRef);
  }

  async sendMessage(chatId: string, text: string, idempotencyKey?: string): Promise<void> {
    if (!this.bot || !this.connected) throw new Error('Telegram gateway not connected');
    this.requireAllowedChat(chatId);
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.runInChatQueue(chatId, () => this.sendMessageNow(chatId, trimmed, idempotencyKey));
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getLastMessageAt(): number | undefined {
    return this.lastMessageAt;
  }

  private ownerAllowed(chatId: string, userId: string): boolean {
    if (!this.config.allowedChats?.includes(chatId)) return false;
    if (this.config.ownerUserIds !== undefined) return this.config.ownerUserIds.includes(userId);
    return this.config.allowedChats.length === 1 && this.config.allowedChats[0] === userId;
  }

  private requireAllowedChat(chatId: string): void {
    if (!this.config.allowedChats?.includes(chatId)) {
      throw new Error('Telegram destination is not allowlisted');
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.chat || !message.from || message.from.is_bot) return;
    const chatId = String(message.chat.id);
    const userId = String(message.from.id);
    if (!this.ownerAllowed(chatId, userId)) return;

    const ref = sourceMessageRef(chatId, message.message_id);
    const now = Date.now();
    const previous = this.recentMessageIds.get(ref);
    if (previous !== undefined && now - previous <= MESSAGE_DEDUP_TTL_MS) return;
    this.recentMessageIds.set(ref, now);
    for (const [key, timestamp] of this.recentMessageIds) {
      if (now - timestamp > MESSAGE_DEDUP_TTL_MS) this.recentMessageIds.delete(key);
    }

    const durable = this.messageLedger.get(ref);
    if (durable?.state === 'delivered') return;
    if (durable?.state === 'ready') {
      await this.deliverReadyEntry(ref);
      return;
    }
    if (durable?.state === 'processing' && this.activePresenters.has(ref)) return;
    if (durable?.state === 'processing' && this.intake.isPending?.(ref)) return;
    if (durable?.state === 'processing') {
      this.messageLedger.markReady(ref, INTERRUPTED_RESPONSE, 'html-v1');
      await this.deliverReadyEntry(ref);
      return;
    }

    const selected = selectTelegramTextEntities(message);
    if (!selected.text.trim()) return;
    const formatting = captureTelegramTextFormatting(
      selected.field,
      selected.text,
      selected.entities
    );
    const ledgerEntry = this.messageLedger.claim(ref).entry;
    const presenter = this.createResponsePresenter(ref, Number(message.chat.id));
    this.activePresenters.set(ref, presenter);
    try {
      if (ledgerEntry.state !== 'ready') await presenter.start();
      const formattingPayload = payloadForFormatting(formatting);
      const input: OwnerMessageInput = {
        id: ref,
        channelKey: chatId,
        occurredAt: message.date * 1000,
        text: selected.text,
        ...(formattingPayload === undefined ? {} : { payload: formattingPayload }),
      };
      this.intake.acceptOwnerMessage(input);
      this.emitEvent({
        type: 'message_received',
        source: 'telegram',
        timestamp: new Date(),
        data: { sourceMessageRef: ref },
      });
    } catch (error) {
      this.activePresenters.delete(ref);
      throw error;
    }
  }

  private createResponsePresenter(sourceRef: string, chatId: number): TelegramResponsePresenter {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    return new TelegramResponsePresenter(
      {
        send: (content) =>
          sendFormattedMessage(this.bot!.api, chatId, content).then((sent) =>
            String(sent.message_id)
          ),
        edit: (handle, content) =>
          editFormattedMessage(this.bot!.api, chatId, Number(handle), content),
        delete: async (handle) => {
          await this.bot!.api.deleteMessage(chatId, Number(handle));
        },
      },
      {
        resumeFromChunk: this.messageLedger.get(sourceRef)?.nextChunkIndex ?? 0,
        chunkFormat: this.messageLedger.get(sourceRef)?.chunkFormat ?? 'html-v1',
        withDelivery: (send) => this.runInChatQueue(String(chatId), send, true),
        onChunkProgress: (nextIndex, uncertain) => {
          const entry = this.messageLedger.get(sourceRef);
          if (entry?.state === 'ready') {
            this.messageLedger.markDeliveryProgress(sourceRef, nextIndex, uncertain);
          }
        },
      }
    );
  }

  private async deliverReadyEntry(sourceRef: string): Promise<void> {
    const entry = this.messageLedger.get(sourceRef);
    if (!entry || entry.state === 'delivered') return;
    if (entry.response === undefined) throw new Error('Telegram ready entry has no response');
    const chatId = Number(chatIdFromSourceMessageRef(sourceRef));
    await this.runInChatQueue(String(chatId), async () => {
      const current = this.messageLedger.get(sourceRef);
      if (!current || current.state === 'delivered') return;
      const presenter =
        this.activePresenters.get(sourceRef) ?? this.createResponsePresenter(sourceRef, chatId);
      await presenter.finalize(current.response!);
      this.messageLedger.markDelivered(sourceRef);
      this.activePresenters.delete(sourceRef);
      this.lastMessageAt = Date.now();
      this.emitEvent({
        type: 'message_sent',
        source: 'telegram',
        timestamp: new Date(),
        data: { sourceMessageRef: sourceRef },
      });
    });
  }

  private async recoverPendingResponses(): Promise<void> {
    for (const entry of this.messageLedger.listUndelivered()) {
      if (!entry.key.startsWith('telegram:')) continue;
      const chatId = chatIdFromSourceMessageRef(entry.key);
      if (!this.config.allowedChats?.includes(chatId)) continue;
      if (entry.state === 'ready' && entry.response !== undefined) {
        await this.deliverReadyEntry(entry.key);
        continue;
      }
      if (entry.state === 'processing' && !this.intake.isPending?.(entry.key)) {
        this.messageLedger.markReady(entry.key, INTERRUPTED_RESPONSE, 'html-v1');
        await this.deliverReadyEntry(entry.key);
      }
    }
  }

  private async sendMessageNow(
    chatId: string,
    text: string,
    idempotencyKey?: string
  ): Promise<void> {
    if (!this.bot) throw new Error('Telegram gateway not connected');
    const chunks = formatTelegramMessage(text, TELEGRAM_MAX_LENGTH, 'html-v1');
    if (!idempotencyKey) {
      for (const chunk of chunks) await sendFormattedMessage(this.bot.api, Number(chatId), chunk);
      return;
    }

    const key = outboundLedgerKey(idempotencyKey);
    const binding = {
      deliveryTarget: `telegram:${chatId}`,
      payloadIdentity: createHash('sha256').update(text).digest('hex'),
    };
    const existing = this.messageLedger.claim(key, binding).entry;
    if (existing.state === 'delivered') return;
    const start = existing.state === 'ready' ? (existing.nextChunkIndex ?? 0) : 0;
    if (existing.state !== 'ready') this.messageLedger.markReady(key, text, 'html-v1');
    for (let index = start; index < chunks.length; index += 1) {
      this.messageLedger.markDeliveryProgress(key, index, true);
      await sendFormattedMessage(this.bot.api, Number(chatId), chunks[index]!);
      this.messageLedger.markDeliveryProgress(key, index + 1, false);
    }
    this.messageLedger.markDelivered(key);
  }

  private async runInChatQueue<T>(
    chatId: string,
    work: () => Promise<T>,
    allowReentrant = false
  ): Promise<T> {
    const active = this.activeChat.getStore();
    if (allowReentrant && active?.active && active.chatId === chatId) return work();
    const previous = this.chatTails.get(chatId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = (previous ?? Promise.resolve()).catch(() => {}).then(() => gate);
    this.chatTails.set(chatId, current);
    try {
      if (previous) await previous.catch(() => {});
      return await this.activeChat.run({ chatId, active: true }, work);
    } finally {
      release();
      if (this.chatTails.get(chatId) === current) this.chatTails.delete(chatId);
    }
  }
}

export type { TelegramMessageLedgerEntry };
