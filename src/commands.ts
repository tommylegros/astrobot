/**
 * Telegram Slash Commands for Astrobot v2
 *
 * Handles all slash commands that are processed host-side (without
 * spinning up a container). Each handler receives the orchestrator
 * state and returns a text response to send back to the user.
 */
import {
  ASSISTANT_NAME,
  ORCHESTRATOR_MODEL,
  DEFAULT_AGENT_MODEL,
  EMBEDDING_MODEL,
} from './config.js';
import {
  AgentRow,
  deleteMemoriesByTopic,
  getAllAgents,
  getConversationCount,
  getMemoriesForAgent,
  getMemoryCount,
  getOrchestratorAgent,
  getRecentMessages,
  updateAgent,
} from './db.js';
import { logger } from './logger.js';
import { Channel } from './types.js';

// ── Types ───────────────────────────────────────────────────────────

export interface CommandContext {
  chatId: string;
  channel: Channel;
  orchestratorAgent: AgentRow;
  activeContainerId: string | null;
  conversationId: string | null;
}

export interface CommandResult {
  /** Text to send back to the user */
  text: string;
  /** If true, the command was handled and the orchestrator should NOT process it further */
  handled: boolean;
}

// ── Command registry ────────────────────────────────────────────────

type CommandHandler = (
  ctx: CommandContext,
  args: string,
) => Promise<CommandResult>;

const commands = new Map<string, CommandHandler>();

/**
 * Try to handle a message as a slash command.
 * Returns null if the message is not a command.
 */
export async function tryHandleCommand(
  ctx: CommandContext,
  content: string,
): Promise<CommandResult | null> {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const commandName = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  const handler = commands.get(commandName);
  if (!handler) return null;

  try {
    return await handler(ctx, args);
  } catch (err) {
    logger.error({ err, command: commandName }, 'Command handler error');
    return { text: `Error executing ${commandName}. Please try again.`, handled: true };
  }
}

// ── /status ─────────────────────────────────────────────────────────

commands.set('/status', async (ctx) => {
  const agent = ctx.orchestratorAgent;
  const memoryCount = await getMemoryCount(agent.id);
  const conversationCount = await getConversationCount(agent.id);
  const allAgents = await getAllAgents();
  const specialists = allAgents.filter((a) => !a.is_orchestrator);

  const containerStatus = ctx.activeContainerId ? 'Active' : 'Idle';

  const lines = [
    `*${ASSISTANT_NAME} Status*`,
    '',
    `*Connection:* Connected`,
    `*Container:* ${containerStatus}`,
    `*Orchestrator Model:* \`${agent.model}\``,
    `*Embedding Model:* \`${EMBEDDING_MODEL}\``,
    `*Specialist Agents:* ${specialists.length}`,
    `*Memories:* ${memoryCount}`,
    `*Conversations:* ${conversationCount}`,
    `*Conversation:* ${ctx.conversationId ? 'Active' : 'None'}`,
  ];

  return { text: lines.join('\n'), handled: true };
});

// ── /memory ─────────────────────────────────────────────────────────

commands.set('/memory', async (ctx) => {
  const memories = await getMemoriesForAgent(ctx.orchestratorAgent.id, 20);

  if (memories.length === 0) {
    return { text: `I don't have any memories stored yet.`, handled: true };
  }

  const lines = [`*${ASSISTANT_NAME}'s Memories* (${memories.length} most recent)\n`];

  for (const mem of memories) {
    const date = new Date(mem.created_at).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    const typeLabel = mem.memory_type === 'conversation_summary' ? '💬' : '📝';
    // Truncate long memories for readability
    const content = mem.content.length > 150
      ? mem.content.slice(0, 147) + '...'
      : mem.content;
    lines.push(`${typeLabel} \`${date}\` — ${content}`);
  }

  return { text: lines.join('\n'), handled: true };
});

// ── /forget ─────────────────────────────────────────────────────────

commands.set('/forget', async (ctx, args) => {
  if (!args) {
    return {
      text: 'Usage: `/forget <topic>`\n\nExample: `/forget my address`\n\nThis removes all memories matching the topic.',
      handled: true,
    };
  }

  const deleted = await deleteMemoriesByTopic(ctx.orchestratorAgent.id, args);

  if (deleted === 0) {
    return { text: `No memories found matching "${args}".`, handled: true };
  }

  return {
    text: `Removed ${deleted} memor${deleted === 1 ? 'y' : 'ies'} matching "${args}".`,
    handled: true,
  };
});

// ── /model ──────────────────────────────────────────────────────────

commands.set('/model', async (ctx, args) => {
  if (!args) {
    const agent = ctx.orchestratorAgent;
    return {
      text: [
        `*Current Model:* \`${agent.model}\``,
        '',
        'Usage: `/model <model-name>`',
        '',
        'Examples:',
        '`/model anthropic/claude-sonnet-4-20250514`',
        '`/model google/gemini-2.5-pro-preview-05-06`',
        '`/model deepseek/deepseek-chat`',
        '`/model openai/gpt-4o`',
        '',
        'Use any model available on [OpenRouter](https://openrouter.ai/models).',
      ].join('\n'),
      handled: true,
    };
  }

  const previousModel = ctx.orchestratorAgent.model;
  await updateAgent(ctx.orchestratorAgent.id, { model: args });

  // Update the in-memory agent reference so subsequent messages use the new model
  ctx.orchestratorAgent.model = args;

  return {
    text: `Model switched from \`${previousModel}\` to \`${args}\`.\n\nNote: The change takes effect on the next container spawn.`,
    handled: true,
  };
});

// ── /agents ─────────────────────────────────────────────────────────

commands.set('/agents', async () => {
  const allAgents = await getAllAgents();
  const specialists = allAgents.filter((a) => !a.is_orchestrator);

  if (specialists.length === 0) {
    return {
      text: 'No specialist agents configured yet.\n\nTell me to create one, e.g. "Create a coding agent".',
      handled: true,
    };
  }

  const lines = [`*Specialist Agents* (${specialists.length})\n`];

  for (const agent of specialists) {
    const desc = agent.system_prompt.length > 100
      ? agent.system_prompt.slice(0, 97) + '...'
      : agent.system_prompt;
    lines.push(`*${agent.name}*`);
    lines.push(`  Model: \`${agent.model}\``);
    lines.push(`  ${desc}`);
    lines.push('');
  }

  return { text: lines.join('\n'), handled: true };
});

// ── /delegate ───────────────────────────────────────────────────────

commands.set('/delegate', async (ctx, args) => {
  if (!args) {
    const allAgents = await getAllAgents();
    const specialists = allAgents.filter((a) => !a.is_orchestrator);
    const names = specialists.map((a) => `\`${a.name}\``).join(', ');

    return {
      text: [
        'Usage: `/delegate <agent> <task>`',
        '',
        `Available agents: ${names || '(none)'}`,
        '',
        'Example: `/delegate coder Write a Python script to sort a list`',
      ].join('\n'),
      handled: true,
    };
  }

  // Parse: first word is agent name, rest is the task
  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1) {
    return {
      text: 'Please provide both an agent name and a task.\n\nUsage: `/delegate <agent> <task>`',
      handled: true,
    };
  }

  const agentName = args.slice(0, spaceIdx);
  const task = args.slice(spaceIdx + 1).trim();

  // Verify agent exists
  const allAgents = await getAllAgents();
  const targetAgent = allAgents.find(
    (a) => a.name.toLowerCase() === agentName.toLowerCase() && !a.is_orchestrator,
  );

  if (!targetAgent) {
    const specialists = allAgents.filter((a) => !a.is_orchestrator);
    const names = specialists.map((a) => `\`${a.name}\``).join(', ');
    return {
      text: `Agent "${agentName}" not found.\n\nAvailable agents: ${names || '(none)'}`,
      handled: true,
    };
  }

  // Return handled: false so the orchestrator routes this as a delegation.
  // We rewrite the content so the orchestrator understands it as a delegation request.
  return {
    text: `Delegating to *${targetAgent.name}*: ${task}`,
    handled: false,
    // The caller will use the rewritten content below
  } as CommandResult & { delegateAgent: string; delegateTask: string };
});

// ── /history ────────────────────────────────────────────────────────

commands.set('/history', async (ctx, args) => {
  const limit = args ? parseInt(args, 10) : 20;
  const count = isNaN(limit) || limit < 1 ? 20 : Math.min(limit, 50);

  const chatIdNum = parseInt(ctx.chatId, 10);
  if (isNaN(chatIdNum)) {
    return { text: 'Unable to retrieve history for this chat.', handled: true };
  }

  const messages = await getRecentMessages(chatIdNum, count);

  if (messages.length === 0) {
    return { text: 'No message history found.', handled: true };
  }

  const lines = [`*Recent Messages* (last ${messages.length})\n`];

  for (const msg of messages) {
    const time = new Date(msg.created_at).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const arrow = msg.direction === 'inbound' ? '→' : '←';
    const content = msg.content.length > 120
      ? msg.content.slice(0, 117) + '...'
      : msg.content;
    lines.push(`\`${time}\` ${arrow} *${msg.sender}*: ${content}`);
  }

  return { text: lines.join('\n'), handled: true };
});
