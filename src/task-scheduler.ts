/**
 * Task Scheduler for Astrobot v2
 *
 * Polls PostgreSQL for due tasks and runs them via agent containers.
 */
import { CronExpressionParser } from 'cron-parser';

import { DATABASE_URL, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { runContainerAgent } from './container-runner.js';
import {
  AgentRow,
  getAgentById,
  getDueTasks,
  getTaskById,
  TaskRow,
  updateTask,
} from './db.js';
import { logger } from './logger.js';
import { getMCPServersForAgent } from './mcp-registry.js';
import { Channel, ContainerOutput } from './types.js';

export interface SchedulerDeps {
  channel: Channel;
  chatId: () => string | null;
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDeps): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = await getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check status
        const currentTask = await getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') continue;

        // Run in background (don't block the scheduler loop)
        runTaskInBackground(currentTask, deps).catch((err) => {
          logger.error({ taskId: task.id, err }, 'Background task error');
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

async function runTaskInBackground(
  task: TaskRow,
  deps: SchedulerDeps,
): Promise<void> {
  const startTime = Date.now();

  logger.info({ taskId: task.id, agentId: task.agent_id }, 'Running scheduled task');

  const agent = await getAgentById(task.agent_id);
  if (!agent) {
    logger.error({ taskId: task.id, agentId: task.agent_id }, 'Agent not found for task');
    await updateTask(task.id, { status: 'completed', last_result: 'Agent not found' });
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    const mcpServers = await getMCPServersForAgent(agent, DATABASE_URL);

    const output = await runContainerAgent({
      input: {
        prompt: `[SCHEDULED TASK]\n\n${task.prompt}`,
        agentId: agent.id,
        agentName: agent.name,
        model: agent.model,
        systemPrompt: agent.system_prompt,
        isOrchestrator: false,
        mcpServers,
      },
      onOutput: async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward to user if we have a chat
          const chatId = deps.chatId();
          if (chatId) {
            await deps.channel.sendMessage(chatId, streamedOutput.result);
          }
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    });

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  // Calculate next run
  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';

  await updateTask(task.id, {
    next_run: nextRun,
    last_run: new Date().toISOString(),
    last_result: resultSummary,
    status: nextRun ? 'active' : 'completed',
  });

  logger.info({ taskId: task.id, durationMs, status: error ? 'error' : 'success' }, 'Task completed');
}
