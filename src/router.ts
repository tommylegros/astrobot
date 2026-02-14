/**
 * Message Router for Astrobot v2
 *
 * Simplified for single-channel (Telegram DM) architecture.
 * Formats messages for agent consumption and handles outbound formatting.
 */
import { ASSISTANT_NAME } from './config.js';
import { Channel } from './types.js';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format a user message for the agent prompt.
 * In DM mode, messages are simple user turns.
 */
export function formatUserMessage(sender: string, content: string, timestamp: string): string {
  return `<message sender="${escapeXml(sender)}" time="${timestamp}">${escapeXml(content)}</message>`;
}

/**
 * Strip <internal>...</internal> blocks from agent output.
 * Agents use these for internal reasoning that shouldn't be shown to users.
 */
export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Format agent output for sending to the user.
 * Strips internal tags and returns clean text.
 */
export function formatOutbound(rawText: string): string {
  return stripInternalTags(rawText);
}

/**
 * Send a message through the channel.
 */
export async function sendViaChannel(
  channel: Channel,
  chatId: string,
  text: string,
): Promise<void> {
  const formatted = formatOutbound(text);
  if (!formatted) return;
  await channel.sendMessage(chatId, formatted);
}
