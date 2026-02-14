/**
 * IPC Watcher for Astrobot v2
 *
 * Polls IPC directories for messages from agent containers.
 * Routes messages to Telegram and handles task/delegation commands.
 */
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { writeAgentsSnapshot } from './agent-snapshot.js';
import { ASSISTANT_NAME, DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  createAgent,
  createTask,
  deleteAgent,
  getAgentByName,
  getAllAgents,
  getTaskById,
  updateAgent,
  updateTask,
  deleteTask,
} from './db.js';
import { logger } from './logger.js';
import { handleIpcMessage } from './orchestrator.js';
import { Channel } from './types.js';

export interface IpcDeps {
  channel: Channel;
  chatId: () => string | null;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    let agentDirs: string[];
    try {
      agentDirs = fs.readdirSync(ipcBaseDir).filter((f) => {
        try {
          return fs.statSync(path.join(ipcBaseDir, f)).isDirectory() && f !== 'errors';
        } catch {
          return false;
        }
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const agentDir of agentDirs) {
      const messagesDir = path.join(ipcBaseDir, agentDir, 'messages');
      const tasksDir = path.join(ipcBaseDir, agentDir, 'tasks');

      // Process outbound messages
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));

          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);

              // Route through orchestrator handler
              await handleIpcMessage(data);
            } catch (err) {
              logger.error({ file, agentDir, err }, 'Error processing IPC message');
              moveToErrors(ipcBaseDir, filePath, agentDir, file);
            }
          }
        }
      } catch (err) {
        logger.error({ err, agentDir }, 'Error reading IPC messages directory');
      }

      // Process task commands
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));

          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              await processTaskIpc(data, agentDir);
            } catch (err) {
              logger.error({ file, agentDir, err }, 'Error processing IPC task');
              moveToErrors(ipcBaseDir, filePath, agentDir, file);
            }
          }
        }
      } catch (err) {
        logger.error({ err, agentDir }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

function moveToErrors(
  ipcBaseDir: string,
  filePath: string,
  agentDir: string,
  file: string,
): void {
  try {
    const errorDir = path.join(ipcBaseDir, 'errors');
    fs.mkdirSync(errorDir, { recursive: true });
    fs.renameSync(filePath, path.join(errorDir, `${agentDir}-${file}`));
  } catch {
    /* ignore */
  }
}

async function processTaskIpc(
  data: Record<string, unknown>,
  sourceAgentDir: string,
): Promise<void> {
  switch (data.type) {
    case 'schedule_task': {
      const prompt = data.prompt as string;
      const scheduleType = data.schedule_type as string;
      const scheduleValue = data.schedule_value as string;
      const targetAgentName = (data.targetAgent as string) || sourceAgentDir;

      if (!prompt || !scheduleType || !scheduleValue) {
        logger.warn({ data }, 'Invalid schedule_task: missing fields');
        break;
      }

      // Resolve target agent
      const targetAgent = await getAgentByName(targetAgentName);
      if (!targetAgent) {
        logger.warn({ targetAgentName }, 'Cannot schedule task: agent not found');
        break;
      }

      let nextRun: string | null = null;
      if (scheduleType === 'cron') {
        try {
          const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn({ scheduleValue }, 'Invalid cron expression');
          break;
        }
      } else if (scheduleType === 'interval') {
        const ms = parseInt(scheduleValue, 10);
        if (isNaN(ms) || ms <= 0) break;
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (scheduleType === 'once') {
        const scheduled = new Date(scheduleValue);
        if (isNaN(scheduled.getTime())) break;
        nextRun = scheduled.toISOString();
      }

      await createTask({
        agent_id: targetAgent.id,
        prompt,
        schedule_type: scheduleType,
        schedule_value: scheduleValue,
        next_run: nextRun || undefined,
      });

      logger.info({ targetAgent: targetAgentName, scheduleType }, 'Task created via IPC');
      break;
    }

    case 'delegate_to_agent': {
      // Delegation is handled by the orchestrator module
      await handleIpcMessage(data as Record<string, unknown> & { type: string });
      break;
    }

    case 'pause_task': {
      const taskId = data.taskId as string;
      if (taskId) {
        const task = await getTaskById(taskId);
        if (task) {
          await updateTask(taskId, { status: 'paused' });
          logger.info({ taskId }, 'Task paused via IPC');
        }
      }
      break;
    }

    case 'resume_task': {
      const taskId = data.taskId as string;
      if (taskId) {
        const task = await getTaskById(taskId);
        if (task) {
          await updateTask(taskId, { status: 'active' });
          logger.info({ taskId }, 'Task resumed via IPC');
        }
      }
      break;
    }

    case 'cancel_task': {
      const taskId = data.taskId as string;
      if (taskId) {
        await deleteTask(taskId);
        logger.info({ taskId }, 'Task cancelled via IPC');
      }
      break;
    }

    case 'create_agent': {
      const name = data.name as string;
      const systemPrompt = data.system_prompt as string;
      const model = data.model as string;

      if (!name || !systemPrompt || !model) {
        logger.warn({ data }, 'Invalid create_agent: missing required fields');
        break;
      }

      // Prevent creating orchestrator agents
      const existing = await getAgentByName(name);
      if (existing?.is_orchestrator) {
        logger.warn({ name }, 'Cannot overwrite orchestrator agent');
        break;
      }

      await createAgent({
        name,
        system_prompt: systemPrompt,
        model,
        mcp_servers: (data.mcp_servers as object[]) || [],
        is_orchestrator: false,
      });

      // Refresh the agents snapshot so the container can see the new agent
      await writeAgentsSnapshot();

      logger.info({ name, model }, 'Specialist agent created via IPC');
      break;
    }

    case 'update_agent': {
      const name = data.name as string;
      if (!name) {
        logger.warn({ data }, 'Invalid update_agent: missing name');
        break;
      }

      const agent = await getAgentByName(name);
      if (!agent) {
        logger.warn({ name }, 'Cannot update agent: not found');
        break;
      }

      if (agent.is_orchestrator) {
        logger.warn({ name }, 'Cannot modify orchestrator agent via IPC');
        break;
      }

      const updates: Record<string, unknown> = {};
      if (data.system_prompt !== undefined) updates.system_prompt = data.system_prompt;
      if (data.model !== undefined) updates.model = data.model;
      if (data.mcp_servers !== undefined) updates.mcp_servers = data.mcp_servers;

      if (Object.keys(updates).length > 0) {
        await updateAgent(agent.id, updates as Parameters<typeof updateAgent>[1]);
        await writeAgentsSnapshot();
        logger.info({ name, fields: Object.keys(updates) }, 'Specialist agent updated via IPC');
      }
      break;
    }

    case 'delete_agent': {
      const name = data.name as string;
      if (!name) {
        logger.warn({ data }, 'Invalid delete_agent: missing name');
        break;
      }

      const agent = await getAgentByName(name);
      if (!agent) {
        logger.warn({ name }, 'Cannot delete agent: not found');
        break;
      }

      if (agent.is_orchestrator) {
        logger.warn({ name }, 'Cannot delete orchestrator agent');
        break;
      }

      await deleteAgent(agent.id);
      await writeAgentsSnapshot();
      logger.info({ name }, 'Specialist agent deleted via IPC');
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// Re-export for convenience
export { writeAgentsSnapshot } from './agent-snapshot.js';
