/**
 * Agent Queue for Astrobot v2
 *
 * Manages concurrency for agent containers.
 * Simplified from the group-based queue to agent-based.
 */
import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  fn: () => Promise<void>;
}

export class AgentQueue {
  private activeCount = 0;
  private pendingTasks: QueuedTask[] = [];
  private shuttingDown = false;

  /**
   * Enqueue a task. If under the concurrency limit, runs immediately.
   * Otherwise queues for later execution.
   */
  enqueue(taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    // Prevent double-queuing
    if (this.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ taskId }, 'Task already queued, skipping');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      this.pendingTasks.push({ id: taskId, fn });
      logger.debug(
        { taskId, activeCount: this.activeCount, pending: this.pendingTasks.length },
        'At concurrency limit, task queued',
      );
      return;
    }

    this.runTask({ id: taskId, fn });
  }

  private async runTask(task: QueuedTask): Promise<void> {
    this.activeCount++;
    logger.debug(
      { taskId: task.id, activeCount: this.activeCount },
      'Running task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ taskId: task.id, err }, 'Task error');
    } finally {
      this.activeCount--;
      this.drainPending();
    }
  }

  private drainPending(): void {
    if (this.shuttingDown) return;

    while (
      this.pendingTasks.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const task = this.pendingTasks.shift()!;
      this.runTask(task);
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    logger.info(
      { activeCount: this.activeCount, pending: this.pendingTasks.length },
      'AgentQueue shutting down',
    );
  }
}
