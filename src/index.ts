/**
 * Astrobot v2 — Main Entry Point
 *
 * Personal AI assistant with:
 * - OpenRouter LLM backend
 * - Telegram DM interface
 * - Docker-based agent containers
 * - PostgreSQL + pgvector memory
 * - MCP-based tool system
 * - 1Password credential management
 * - Orchestrator → Specialist agent delegation
 */
import { ASSISTANT_NAME, DATABASE_URL, ORCHESTRATOR_MODEL, TELEGRAM_BOT_TOKEN_REF, TELEGRAM_OWNER_CHAT_ID } from './config.js';
import { TelegramChannel } from './channels/telegram.js';
import { initDocker, ensureDockerReady } from './container-runner.js';
import { resolveSecret } from './credentials.js';
import { createAgent, getOrchestratorAgent, getState, setState, initDatabase, shutdownDatabase } from './db.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import { handleMessage, initOrchestrator, shutdownOrchestrator } from './orchestrator.js';
import { startSchedulerLoop } from './task-scheduler.js';

let telegram: TelegramChannel;
let currentChatId: string | null = null;

async function seedOrchestratorAgent(): Promise<void> {
  const existing = await getOrchestratorAgent();
  if (existing) {
    logger.debug('Orchestrator agent already exists');
    return;
  }

  logger.info('Seeding orchestrator agent...');
  await createAgent({
    name: 'orchestrator',
    system_prompt: `You are ${ASSISTANT_NAME}, a personal AI assistant. You are the orchestrator — the main point of contact for the user.

Your responsibilities:
1. Understand the user's requests clearly
2. Ask clarifying questions when needed
3. Delegate tasks to specialist agents when appropriate
4. Provide direct answers for simple questions
5. Remember important context about the user
6. Manage specialist agents (create, update, delete) on the user's behalf

CRITICAL: When creating or updating agents, you MUST ask the user which model to use. Never choose a model yourself — the user controls all model decisions.

Be conversational, helpful, and proactive. When a task is complex or specialized, delegate it to the right specialist agent rather than trying to handle everything yourself. If no suitable specialist exists, offer to create one.`,
    model: ORCHESTRATOR_MODEL,
    is_orchestrator: true,
  });

  logger.info('Orchestrator agent seeded');
}

async function main(): Promise<void> {
  logger.info('Starting Astrobot v2...');

  // 1. Initialize Docker
  initDocker();
  await ensureDockerReady();
  logger.info('Docker ready');

  // 2. Initialize PostgreSQL
  await initDatabase(DATABASE_URL);

  // 3. Seed orchestrator agent if needed
  await seedOrchestratorAgent();

  // 4. Resolve Telegram bot token
  const botToken = await resolveSecret('TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN_REF);
  if (!botToken) {
    throw new Error(
      'Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN env var or configure 1Password reference.',
    );
  }

  // 5. Load owner chat ID (from env or DB)
  let ownerChatId: number | undefined = TELEGRAM_OWNER_CHAT_ID;
  if (!ownerChatId) {
    const stored = await getState('owner_chat_id') as number | null;
    if (stored) {
      ownerChatId = stored;
      logger.info({ ownerChatId }, 'Loaded owner chat ID from database');
    }
  }

  // 6. Create Telegram channel (with allowlist if owner is known)
  telegram = new TelegramChannel({
    botToken,
    allowedChatIds: ownerChatId ? [ownerChatId] : undefined,
    onMessage: async (chatId, msg) => {
      const numericChatId = parseInt(chatId, 10);

      // Auto-register first user as owner if no owner yet
      if (!ownerChatId) {
        ownerChatId = numericChatId;
        await setState('owner_chat_id', ownerChatId);
        telegram.addAllowedChat(ownerChatId);
        logger.info(
          { ownerChatId, sender: msg.senderName },
          'First message — registered as owner',
        );
      }

      currentChatId = chatId;

      // Route to orchestrator
      handleMessage(chatId, msg.senderName, msg.content).catch((err) => {
        logger.error({ err, chatId }, 'Error handling message');
      });
    },
  });

  // 7. Initialize orchestrator
  await initOrchestrator(telegram);

  // 8. Start subsystems
  startIpcWatcher({
    channel: telegram,
    chatId: () => currentChatId,
  });

  startSchedulerLoop({
    channel: telegram,
    chatId: () => currentChatId,
  });

  // 9. Connect Telegram (starts listening)
  await telegram.connect();

  if (!ownerChatId) {
    logger.info('No owner registered — first person to message the bot will be auto-registered');
  }

  // 10. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await shutdownOrchestrator();
    await telegram.disconnect();
    await shutdownDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info(`Astrobot v2 running — ${ASSISTANT_NAME} is ready on Telegram`);
}

// Guard: only run when executed directly
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start Astrobot');
    process.exit(1);
  });
}
