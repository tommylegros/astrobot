/**
 * Orchestrator for Astrobot v2
 *
 * The orchestrator is the master agent that:
 * 1. Receives all incoming user messages
 * 2. Maintains a long-running conversation (8hr container TTL)
 * 3. Asks clarifying questions when needed
 * 4. Delegates tasks to specialist agents
 * 5. Relays results back to the user
 *
 * Conversation lifecycle:
 * - /clear command: summarize + embed conversation, start fresh
 * - 8hr container recycle: auto-summarize before shutdown
 */
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, DATABASE_URL, IDLE_TIMEOUT, ORCHESTRATOR_TTL } from './config.js';
import {
  runContainerAgent,
  sendIpcMessage,
  closeAgentContainer,
} from './container-runner.js';
import {
  AgentRow,
  appendConversationMessages,
  createConversation,
  getActiveConversation,
  getAllAgents,
  getOrchestratorAgent,
  logMessage,
  summarizeConversation,
} from './db.js';
import { embed } from './embedding.js';
import { storeMemory } from './db.js';
import { writeAgentsSnapshot } from './agent-snapshot.js';
import { logger } from './logger.js';
import { getMCPServersForAgent } from './mcp-registry.js';
import { formatOutbound } from './router.js';
import { Channel, ContainerOutput, MediaAttachment } from './types.js';

interface OrchestratorState {
  agent: AgentRow;
  activeContainerId: string | null;
  chatId: string | null;
  conversationId: string | null;
  lastActivity: number;
  recycleTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

let state: OrchestratorState | null = null;
let channel: Channel | null = null;

/**
 * Initialize the orchestrator.
 * Loads the orchestrator agent definition and prepares for incoming messages.
 */
export async function initOrchestrator(telegramChannel: Channel): Promise<void> {
  channel = telegramChannel;

  const agent = await getOrchestratorAgent();
  if (!agent) {
    throw new Error(
      'No orchestrator agent defined. Create an agent with is_orchestrator=true.',
    );
  }

  state = {
    agent,
    activeContainerId: null,
    chatId: null,
    conversationId: null,
    lastActivity: Date.now(),
    recycleTimer: null,
    idleTimer: null,
  };

  logger.info(
    { agentName: agent.name, model: agent.model },
    'Orchestrator initialized',
  );
}

/**
 * Handle an incoming user message.
 * Routes to the orchestrator agent container.
 */
export async function handleMessage(
  chatId: string,
  senderName: string,
  content: string,
  media?: MediaAttachment[],
): Promise<void> {
  if (!state || !channel) {
    logger.error('Orchestrator not initialized');
    return;
  }

  // Handle /clear command
  if (content.trim() === '/clear') {
    await handleClear(chatId);
    return;
  }

  state.chatId = chatId;
  state.lastActivity = Date.now();

  // Log inbound message
  await logMessage({
    telegram_chat_id: parseInt(chatId, 10) || undefined,
    sender: senderName,
    content,
    direction: 'inbound',
    agent_id: state.agent.id,
  });

  // Ensure active conversation exists
  if (!state.conversationId) {
    const conv = await getActiveConversation(state.agent.id);
    if (conv) {
      state.conversationId = conv.id;
    } else {
      const newConv = await createConversation(state.agent.id);
      state.conversationId = newConv.id;
    }
  }

  // Append user message to conversation
  await appendConversationMessages(state.conversationId!, [
    { role: 'user', content, sender: senderName, timestamp: new Date().toISOString() },
  ]);

  // Convert media attachments for IPC
  const ipcMedia = media?.map((m) => ({
    type: m.type,
    path: m.path,
    mimeType: m.mimeType,
  }));

  // If there's an active container, pipe the message to it
  if (state.activeContainerId) {
    const sent = sendIpcMessage(state.agent.id, content, ipcMedia);
    if (sent) {
      logger.debug({ chatId, hasMedia: !!media?.length }, 'Piped message to active orchestrator container');
      resetIdleTimer();
      return;
    }
    // Container is gone, need to spawn a new one
    state.activeContainerId = null;
  }

  // Spawn a new orchestrator container
  await spawnOrchestratorContainer(chatId, content, media);
}

/**
 * Spawn a new orchestrator container.
 */
async function spawnOrchestratorContainer(
  chatId: string,
  prompt: string,
  media?: MediaAttachment[],
): Promise<void> {
  if (!state || !channel) return;

  // Show typing indicator
  await channel.setTyping?.(chatId, true);

  // Write agents snapshot so the container can read it via list_agents tool
  await writeAgentsSnapshot();

  // Build agent list for the system prompt
  const allAgents = await getAllAgents();
  const specialists = allAgents.filter((a) => !a.is_orchestrator);
  const agentList = specialists.length > 0
    ? specialists.map((a) => `- **${a.name}** (model: \`${a.model}\`): ${a.system_prompt.slice(0, 100)}`).join('\n')
    : '(No specialist agents configured yet — you can create them with create_agent)';

  // Build system prompt with agent awareness
  const systemPrompt = `${state.agent.system_prompt}

## Available Specialist Agents
${agentList}

## Tools
You have access to the following tool categories:
- **send_message**: Send messages to the user immediately
- **ask_user**: Ask the user clarifying questions
- **delegate_to_agent**: Delegate tasks to specialist agents
- **create_agent / update_agent / delete_agent / list_agents**: Manage specialist agents
- **remember / recall**: Store and retrieve long-term memories
- **schedule_task**: Schedule recurring or one-time tasks

## CRITICAL RULE: Model Selection
When creating or updating a specialist agent, you MUST ALWAYS ask the user which OpenRouter model to use.
NEVER choose a model yourself. The user has final say on all model decisions.
Example flow:
1. User: "Create a coding agent"
2. You: ask_user → "Which model should the coding agent use? Some options: anthropic/claude-sonnet-4-20250514, openai/gpt-4o, google/gemini-2.0-flash-001, deepseek/deepseek-chat"
3. User: "Use deepseek"
4. You: create_agent with model="deepseek/deepseek-chat"

## Behavior
- You are ${ASSISTANT_NAME}, the user's personal AI assistant
- Maintain a natural conversation flow
- Ask clarifying questions when the user's request is ambiguous
- Delegate to specialist agents when they are better suited for the task
- Remember important information about the user's preferences and context
- When the user wants a new specialist, help them define it but always ask for the model
- Your conversation persists until the user sends /clear or 8 hours pass`;

  // Get MCP servers for this agent
  const mcpServers = await getMCPServersForAgent(state.agent, DATABASE_URL);

  // Prepare media for container input — copy files into IPC media dir
  // and rewrite paths to container-side paths
  let containerMedia: MediaAttachment[] | undefined;
  if (media && media.length > 0) {
    const fs = await import('fs');
    const pathMod = await import('path');
    const mediaDir = pathMod.default.join(DATA_DIR, 'ipc', state.agent.id, 'media');
    fs.default.mkdirSync(mediaDir, { recursive: true });
    try { fs.default.chmodSync(mediaDir, 0o777); } catch { /* best effort */ }

    containerMedia = media.map((m) => {
      const ext = pathMod.default.extname(m.path) || '.jpg';
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const destPath = pathMod.default.join(mediaDir, filename);
      fs.default.copyFileSync(m.path, destPath);
      try { fs.default.chmodSync(destPath, 0o666); } catch { /* best effort */ }
      return {
        type: m.type as 'image',
        path: `/workspace/ipc/media/${filename}`,
        mimeType: m.mimeType,
      };
    });
  }

  state.activeContainerId = state.agent.id;

  const output = await runContainerAgent({
    input: {
      prompt,
      media: containerMedia,
      agentId: state.agent.id,
      agentName: state.agent.name,
      model: state.agent.model,
      systemPrompt,
      conversationId: state.conversationId || undefined,
      isOrchestrator: true,
      mcpServers,
    },
    onOutput: async (result: ContainerOutput) => {
      if (result.result) {
        const text = formatOutbound(result.result);
        if (text) {
          await channel!.sendMessage(chatId, text);

          // Log outbound message
          await logMessage({
            telegram_chat_id: parseInt(chatId, 10) || undefined,
            sender: ASSISTANT_NAME,
            content: text,
            direction: 'outbound',
            agent_id: state!.agent.id,
          });

          // Append assistant response to conversation
          if (state!.conversationId) {
            await appendConversationMessages(state!.conversationId, [
              { role: 'assistant', content: text, timestamp: new Date().toISOString() },
            ]);
          }
        }
        resetIdleTimer();
      }

      if (result.status === 'error') {
        logger.error({ error: result.error }, 'Orchestrator container error');
      }
    },
  });

  await channel.setTyping?.(chatId, false);

  // Container has exited
  state.activeContainerId = null;
  clearTimers();

  if (output.status === 'error') {
    logger.error({ error: output.error }, 'Orchestrator container failed');
    await channel.sendMessage(
      chatId,
      'Sorry, I encountered an error. Please try again.',
    );
  }
}

/**
 * Handle the /clear command.
 * Summarizes the conversation, embeds it, and starts fresh.
 */
async function handleClear(chatId: string): Promise<void> {
  if (!state || !channel) return;

  // If there's an active container, close it
  if (state.activeContainerId) {
    closeAgentContainer(state.agent.id);
    state.activeContainerId = null;
  }

  clearTimers();

  if (state.conversationId) {
    try {
      // Auto-generate a summary (simple approach: use the model)
      const summary = `Conversation cleared by user on ${new Date().toISOString()}`;
      await summarizeConversation(state.conversationId, summary);

      // Try to embed the summary
      try {
        const embedding = await embed(summary);
        await storeMemory({
          agent_id: state.agent.id,
          content: summary,
          embedding,
          memory_type: 'conversation_summary',
        });
      } catch {
        logger.warn('Failed to embed conversation summary');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to summarize conversation');
    }
  }

  // Create new conversation
  const newConv = await createConversation(state.agent.id);
  state.conversationId = newConv.id;

  await channel.sendMessage(chatId, 'Conversation cleared. Starting fresh.');
  logger.info({ chatId }, 'Conversation cleared by user');
}

/**
 * Handle IPC messages from the orchestrator container.
 * Called by the IPC watcher when it finds messages in the orchestrator's IPC directory.
 */
export async function handleIpcMessage(data: {
  type: string;
  text?: string;
  agentId?: string;
  agentName?: string;
  targetAgent?: string;
  task?: string;
  [key: string]: unknown;
}): Promise<void> {
  if (!state || !channel || !state.chatId) return;

  switch (data.type) {
    case 'message':
      if (data.text) {
        const text = formatOutbound(data.text);
        if (text) {
          await channel.sendMessage(state.chatId, text);

          await logMessage({
            telegram_chat_id: parseInt(state.chatId, 10) || undefined,
            sender: data.agentName || ASSISTANT_NAME,
            content: text,
            direction: 'outbound',
            agent_id: state.agent.id,
          });
        }
      }
      break;

    case 'image': {
      // Image sent by agent — read from IPC media dir and send via Telegram
      const imagePath = data.path as string;
      const caption = data.caption as string | undefined;
      if (imagePath) {
        // Resolve container path to host path
        const fs = await import('fs');
        const pathMod = await import('path');
        const agentId = (data.agentId as string) || state.agent.id;
        const hostPath = imagePath.startsWith('/workspace/ipc/')
          ? pathMod.default.join(DATA_DIR, 'ipc', agentId, imagePath.replace('/workspace/ipc/', ''))
          : imagePath;

        if (fs.default.existsSync(hostPath)) {
          if (channel.sendPhoto) {
            await channel.sendPhoto(state.chatId, hostPath, caption ? formatOutbound(caption) : undefined);
          } else {
            // Fallback: send as text if channel doesn't support photos
            await channel.sendMessage(state.chatId, caption || '[Image generated]');
          }

          await logMessage({
            telegram_chat_id: parseInt(state.chatId, 10) || undefined,
            sender: data.agentName || ASSISTANT_NAME,
            content: `[Image: ${caption || 'sent'}]`,
            direction: 'outbound',
            agent_id: state.agent.id,
          });
        } else {
          logger.error({ hostPath, originalPath: imagePath }, 'Image file not found for IPC image message');
        }
      }
      break;
    }

    case 'delegate_to_agent':
      if (data.targetAgent && data.task) {
        await handleDelegation(
          data.targetAgent as string,
          data.task as string,
          data.waitForResult as boolean,
        );
      }
      break;

    default:
      logger.debug({ type: data.type }, 'Unhandled IPC message type');
  }
}

/**
 * Handle delegation from orchestrator to a specialist agent.
 */
async function handleDelegation(
  targetAgentName: string,
  task: string,
  waitForResult: boolean,
): Promise<void> {
  if (!state || !channel || !state.chatId) return;

  const allAgents = await getAllAgents();
  const targetAgent = allAgents.find((a) => a.name === targetAgentName);

  if (!targetAgent) {
    // Send error back to orchestrator
    if (state.activeContainerId) {
      sendIpcMessage(
        state.agent.id,
        `[SYSTEM] Agent "${targetAgentName}" not found. Available agents: ${allAgents.filter((a) => !a.is_orchestrator).map((a) => a.name).join(', ')}`,
      );
    }
    return;
  }

  logger.info(
    { from: state.agent.name, to: targetAgentName, task: task.slice(0, 100) },
    'Delegating task to specialist',
  );

  const mcpServers = await getMCPServersForAgent(targetAgent, DATABASE_URL);

  const result = await runContainerAgent({
    input: {
      prompt: task,
      agentId: targetAgent.id,
      agentName: targetAgent.name,
      model: targetAgent.model,
      systemPrompt: targetAgent.system_prompt,
      isOrchestrator: false,
      mcpServers,
    },
    onOutput: async (output: ContainerOutput) => {
      if (output.result && waitForResult && state?.activeContainerId) {
        // Feed specialist result back to orchestrator
        sendIpcMessage(
          state.agent.id,
          `[SPECIALIST RESULT from ${targetAgentName}]\n${output.result}`,
        );
      }
    },
  });

  if (result.status === 'error' && state.activeContainerId) {
    sendIpcMessage(
      state.agent.id,
      `[SPECIALIST ERROR from ${targetAgentName}] ${result.error}`,
    );
  }
}

// ── Timer management ────────────────────────────────────────────────

function resetIdleTimer(): void {
  if (!state) return;

  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    logger.debug('Orchestrator idle timeout, closing container');
    if (state?.activeContainerId) {
      closeAgentContainer(state.agent.id);
    }
  }, IDLE_TIMEOUT);
}

function clearTimers(): void {
  if (!state) return;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.recycleTimer) {
    clearTimeout(state.recycleTimer);
    state.recycleTimer = null;
  }
}

/**
 * Gracefully shut down the orchestrator.
 * Summarizes conversation if active, closes container.
 */
export async function shutdownOrchestrator(): Promise<void> {
  if (!state) return;

  clearTimers();

  if (state.activeContainerId) {
    closeAgentContainer(state.agent.id);
    state.activeContainerId = null;
  }

  // Summarize active conversation
  if (state.conversationId) {
    try {
      const summary = `Conversation ended due to system shutdown on ${new Date().toISOString()}`;
      await summarizeConversation(state.conversationId, summary);
    } catch {
      logger.warn('Failed to summarize conversation on shutdown');
    }
  }

  state = null;
  logger.info('Orchestrator shut down');
}
