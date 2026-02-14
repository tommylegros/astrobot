/**
 * Telegram Channel for Astrobot v2
 *
 * DM-only mode: only responds to direct messages to the bot.
 * Uses grammy framework for the Telegram Bot API.
 */
import fs from 'fs';
import path from 'path';

import { Bot, Context, InputFile } from 'grammy';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, InboundMessage, MediaAttachment, OnInboundMessage } from '../types.js';

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

    // Handle all slash commands — route through the message handler
    // so the orchestrator's command system can process them.
    for (const cmd of ['clear', 'status', 'memory', 'forget', 'model', 'agents', 'delegate', 'history']) {
      this.bot.command(cmd, async (ctx) => {
        if (!this.isAllowed(ctx)) return;
        if (ctx.chat.type !== 'private') return;

        const chatId = ctx.chat.id.toString();
        // Reconstruct the full command text (grammy strips the /command prefix from ctx.match)
        const fullText = ctx.message?.text || `/${cmd}`;
        const message: InboundMessage = {
          telegramMessageId: ctx.message?.message_id || 0,
          telegramChatId: ctx.chat.id,
          sender: ctx.from?.username || ctx.from?.first_name || 'user',
          senderName: this.getSenderName(ctx),
          content: fullText,
          timestamp: new Date().toISOString(),
        };

        this.onMessage(chatId, message);
      });
    }

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

    // Handle photo messages
    this.bot.on('message:photo', async (ctx) => {
      if (!this.isAllowed(ctx)) return;
      if (ctx.chat.type !== 'private') return;

      const chatId = ctx.chat.id.toString();
      const photos = ctx.message.photo;
      // Pick the largest resolution (last in the array)
      const photo = photos[photos.length - 1];

      try {
        const mediaPath = await this.downloadTelegramFile(photo.file_id);
        const media: MediaAttachment[] = [{
          type: 'image',
          path: mediaPath,
          mimeType: 'image/jpeg', // Telegram always sends photos as JPEG
          filename: path.basename(mediaPath),
        }];

        const message: InboundMessage = {
          telegramMessageId: ctx.message.message_id,
          telegramChatId: ctx.chat.id,
          sender: ctx.from?.username || ctx.from?.first_name || 'user',
          senderName: this.getSenderName(ctx),
          content: ctx.message.caption || 'The user sent a photo.',
          timestamp: new Date(ctx.message.date * 1000).toISOString(),
          media,
        };

        logger.debug(
          { chatId, sender: message.sender, hasCaption: !!ctx.message.caption },
          'Telegram photo received',
        );

        this.onMessage(chatId, message);
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to download Telegram photo');
      }
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

  /**
   * Download a file from Telegram servers to the local media directory.
   * Returns the absolute path to the downloaded file.
   */
  private async downloadTelegramFile(fileId: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error('Telegram returned no file_path');

    const downloadUrl = `https://api.telegram.org/file/bot${this.bot.token}/${filePath}`;
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error(`Failed to download file: ${response.status}`);

    // Save to data/media/ directory
    const mediaDir = path.join(DATA_DIR, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    const ext = path.extname(filePath) || '.jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const localPath = path.join(mediaDir, filename);

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);

    logger.debug({ fileId, localPath, size: buffer.length }, 'Downloaded Telegram file');
    return localPath;
  }

  private getSenderName(ctx: Context): string {
    const from = ctx.from;
    if (!from) return 'Unknown';
    if (from.first_name && from.last_name) {
      return `${from.first_name} ${from.last_name}`;
    }
    return from.first_name || from.username || 'Unknown';
  }

  /** Dynamically add a chat ID to the allowlist (e.g. on first-message registration). */
  addAllowedChat(chatId: number): void {
    if (!this.allowedChatIds) {
      this.allowedChatIds = new Set([chatId]);
    } else {
      this.allowedChatIds.add(chatId);
    }
    logger.info({ chatId }, 'Chat ID added to allowlist');
  }

  async connect(): Promise<void> {
    logger.info('Starting Telegram bot...');

    // Register command menu with Telegram
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Initialize the bot' },
      { command: 'clear', description: 'Clear conversation and start fresh' },
      { command: 'status', description: 'Show bot health and stats' },
      { command: 'memory', description: 'Show what I remember about you' },
      { command: 'forget', description: 'Remove memories by topic' },
      { command: 'model', description: 'View or switch the AI model' },
      { command: 'agents', description: 'List specialist agents' },
      { command: 'delegate', description: 'Delegate a task to an agent' },
      { command: 'history', description: 'Show recent conversation history' },
    ]);

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

  async sendPhoto(chatId: string, photoPath: string, caption?: string): Promise<void> {
    const numericChatId = parseInt(chatId, 10);
    if (isNaN(numericChatId)) {
      logger.error({ chatId }, 'Invalid chat ID for Telegram sendPhoto');
      return;
    }

    if (!fs.existsSync(photoPath)) {
      logger.error({ photoPath }, 'Photo file not found');
      return;
    }

    try {
      const inputFile = new InputFile(photoPath);
      await this.bot.api.sendPhoto(numericChatId, inputFile, {
        caption: caption || undefined,
        parse_mode: caption ? 'Markdown' : undefined,
      });
      logger.debug({ chatId, photoPath }, 'Photo sent via Telegram');
    } catch (err) {
      // If Markdown parsing fails for caption, try plain
      if (caption && err instanceof Error && err.message.includes("can't parse entities")) {
        const inputFile = new InputFile(photoPath);
        await this.bot.api.sendPhoto(numericChatId, inputFile, { caption });
      } else {
        throw err;
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
