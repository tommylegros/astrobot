/**
 * Telegram Channel for Astrobot v2
 *
 * DM-only mode: only responds to direct messages to the bot.
 * Uses grammy framework for the Telegram Bot API.
 */
import { Bot, Context } from 'grammy';

import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel, InboundMessage, OnInboundMessage } from '../types.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface TelegramChannelOptions {
  botToken: string;
  onMessage: OnInboundMessage;
  /** Optional: restrict to specific chat IDs (for security) */
  allowedChatIds?: number[];
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Bot;
  private connected = false;
  private onMessage: OnInboundMessage;
  private allowedChatIds: Set<number> | null;

  constructor(options: TelegramChannelOptions) {
    this.bot = new Bot(options.botToken);
    this.onMessage = options.onMessage;
    this.allowedChatIds = options.allowedChatIds
      ? new Set(options.allowedChatIds)
      : null;

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle /start command
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        `Hi! I'm ${ASSISTANT_NAME}, your personal AI assistant. Send me a message to get started.`,
      );
    });

    // Handle /clear command — triggers conversation reset
    this.bot.command('clear', async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      const chatId = ctx.chat.id.toString();
      const message: InboundMessage = {
        telegramMessageId: ctx.message?.message_id || 0,
        telegramChatId: ctx.chat.id,
        sender: ctx.from?.username || ctx.from?.first_name || 'user',
        senderName: this.getSenderName(ctx),
        content: '/clear',
        timestamp: new Date().toISOString(),
      };

      this.onMessage(chatId, message);
    });

    // Handle all text messages
    this.bot.on('message:text', async (ctx) => {
      if (!this.isAllowed(ctx)) return;

      // DM-only: ignore group messages
      if (ctx.chat.type !== 'private') {
        logger.debug(
          { chatId: ctx.chat.id, type: ctx.chat.type },
          'Ignoring non-DM message',
        );
        return;
      }

      const chatId = ctx.chat.id.toString();
      const message: InboundMessage = {
        telegramMessageId: ctx.message.message_id,
        telegramChatId: ctx.chat.id,
        sender: ctx.from?.username || ctx.from?.first_name || 'user',
        senderName: this.getSenderName(ctx),
        content: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000).toISOString(),
      };

      logger.debug(
        { chatId, sender: message.sender, length: message.content.length },
        'Telegram message received',
      );

      this.onMessage(chatId, message);
    });

    // Error handler
    this.bot.catch((err) => {
      logger.error({ error: err.message }, 'Telegram bot error');
    });
  }

  private isAllowed(ctx: Context): boolean {
    if (!this.allowedChatIds) return true;
    const chatId = ctx.chat?.id;
    if (!chatId || !this.allowedChatIds.has(chatId)) {
      logger.debug({ chatId }, 'Message from non-allowed chat, ignoring');
      return false;
    }
    return true;
  }

  private getSenderName(ctx: Context): string {
    const from = ctx.from;
    if (!from) return 'Unknown';
    if (from.first_name && from.last_name) {
      return `${from.first_name} ${from.last_name}`;
    }
    return from.first_name || from.username || 'Unknown';
  }

  async connect(): Promise<void> {
    logger.info('Starting Telegram bot...');

    // Use long polling
    this.bot.start({
      onStart: (botInfo) => {
        this.connected = true;
        logger.info(
          { username: botInfo.username, id: botInfo.id },
          'Telegram bot connected',
        );
      },
    });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!text.trim()) return;

    const numericChatId = parseInt(chatId, 10);
    if (isNaN(numericChatId)) {
      logger.error({ chatId }, 'Invalid chat ID for Telegram');
      return;
    }

    // Split long messages at Telegram's 4096 char limit
    const chunks = splitMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH);

    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(numericChatId, chunk, {
          parse_mode: 'Markdown',
        });
      } catch (err) {
        // If Markdown parsing fails, try plain text
        if (
          err instanceof Error &&
          err.message.includes("can't parse entities")
        ) {
          await this.bot.api.sendMessage(numericChatId, chunk);
        } else {
          throw err;
        }
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async setTyping(chatId: string, _isTyping: boolean): Promise<void> {
    const numericChatId = parseInt(chatId, 10);
    if (isNaN(numericChatId)) return;

    try {
      await this.bot.api.sendChatAction(numericChatId, 'typing');
    } catch {
      // Typing indicators are best-effort
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.bot.stop();
    logger.info('Telegram bot disconnected');
  }
}

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Tries to split at newlines, then at spaces, then hard-cuts.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      // Try to split at a space
      splitIdx = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength * 0.3) {
      // Hard cut
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
