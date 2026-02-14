/**
 * IPC MCP Server for Astrobot v2
 *
 * Stdio-based MCP server running inside agent containers.
 * Provides tools for agent-to-host communication:
 * - send_message: Send messages to the user via Telegram
 * - delegate_to_agent: Orchestrator delegates tasks to specialists
 * - ask_user: Request clarification from the user
 * - schedule_task: Schedule recurring or one-time tasks
 * - list_tasks / pause_task / resume_task / cancel_task: Task management
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables
const agentId = process.env.ASTROBOT_AGENT_ID!;
const agentName = process.env.ASTROBOT_AGENT_NAME!;
const isOrchestrator = process.env.ASTROBOT_IS_ORCHESTRATOR === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const server = new McpServer({
  name: 'astrobot-ipc',
  version: '2.0.0',
});

// ── send_message ────────────────────────────────────────────────────

server.tool(
  'send_message',
  `Send a message to the user immediately via Telegram while you're still running.
Use this for progress updates, to send multiple messages, or when running as a scheduled task.
You can call this multiple times.`,
  {
    text: z.string().describe('The message text to send'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      text: args.text,
      agentId,
      agentName,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

// ── delegate_to_agent ───────────────────────────────────────────────

server.tool(
  'delegate_to_agent',
  `Delegate a task to a specialist agent. Only available to the orchestrator.
The specialist will execute the task and return a result.
Use this when a task is better handled by a specialist with specific knowledge or tools.`,
  {
    agent_name: z.string().describe('Name of the specialist agent to delegate to'),
    task: z.string().describe('Clear description of what the specialist should do. Include all necessary context.'),
    wait_for_result: z.boolean().default(true).describe('If true, wait for the specialist to complete and return the result. If false, fire-and-forget.'),
  },
  async (args) => {
    if (!isOrchestrator) {
      return {
        content: [{ type: 'text' as const, text: 'Only the orchestrator can delegate to other agents.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'delegate_to_agent',
      targetAgent: args.agent_name,
      task: args.task,
      waitForResult: args.wait_for_result,
      sourceAgent: agentId,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: args.wait_for_result
          ? `Task delegated to "${args.agent_name}". Waiting for result...`
          : `Task delegated to "${args.agent_name}" (fire-and-forget).`,
      }],
    };
  },
);

// ── ask_user ────────────────────────────────────────────────────────

server.tool(
  'ask_user',
  `Ask the user a clarifying question before proceeding.
The question will be sent via Telegram and the user's response will be piped back to you.
Use this when you need more information to complete a task effectively.`,
  {
    question: z.string().describe('The question to ask the user'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'message',
      text: args.question,
      agentId,
      agentName,
      isQuestion: true,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Question sent to user: "${args.question}". Their response will arrive as a follow-up message.`,
      }],
    };
  },
);

// ── schedule_task ───────────────────────────────────────────────────

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "0 9 * * *" for daily at 9am)
• interval: Milliseconds between runs (e.g., "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
  {
    prompt: z.string().describe('What the agent should do when the task runs'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().describe('Cron expression, interval in ms, or ISO timestamp'),
    target_agent: z.string().optional().describe('(Orchestrator only) Name of the agent to run the task. Defaults to self.'),
  },
  async (args) => {
    const targetAgent = isOrchestrator && args.target_agent
      ? args.target_agent
      : agentName;

    writeIpcFile(TASKS_DIR, {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      targetAgent,
      sourceAgent: agentId,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Task scheduled: ${args.schedule_type} - ${args.schedule_value}`,
      }],
    };
  },
);

// ── list_tasks ──────────────────────────────────────────────────────

server.tool(
  'list_tasks',
  'List all scheduled tasks.',
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// ── pause_task ──────────────────────────────────────────────────────

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      agentId,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

// ── resume_task ─────────────────────────────────────────────────────

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      agentId,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

// ── cancel_task ─────────────────────────────────────────────────────

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      agentId,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

// ── create_agent ────────────────────────────────────────────────────

server.tool(
  'create_agent',
  `Create a new specialist agent. Only available to the orchestrator.

IMPORTANT: You MUST ask the user which model to use. Do NOT choose a model yourself.
The user controls model selection for every agent — always use ask_user first to get their model preference.

The model must be a valid OpenRouter model ID (e.g., "anthropic/claude-sonnet-4-20250514", "openai/gpt-4o", "google/gemini-2.0-flash-001").`,
  {
    name: z.string().regex(/^[a-z][a-z0-9-]*$/).describe('Agent name (lowercase, hyphens allowed, e.g., "coder", "research-assistant")'),
    system_prompt: z.string().describe('System prompt defining the agent\'s role, expertise, and behavior'),
    model: z.string().describe('OpenRouter model ID — MUST be provided by the user, never chosen by you'),
    mcp_servers: z.array(z.object({
      name: z.string(),
      transport: z.enum(['stdio', 'sse', 'streamable-http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string()).optional(),
    })).optional().describe('Additional MCP servers for this agent (beyond the built-in IPC and Memory servers)'),
  },
  async (args) => {
    if (!isOrchestrator) {
      return {
        content: [{ type: 'text' as const, text: 'Only the orchestrator can create agents.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'create_agent',
      name: args.name,
      system_prompt: args.system_prompt,
      model: args.model,
      mcp_servers: args.mcp_servers || [],
      sourceAgent: agentId,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Agent "${args.name}" creation requested (model: ${args.model}).`,
      }],
    };
  },
);

// ── update_agent ────────────────────────────────────────────────────

server.tool(
  'update_agent',
  `Update an existing specialist agent. Only available to the orchestrator.

IMPORTANT: If changing the model, you MUST ask the user which model to use. Do NOT choose a model yourself.
You can update the system prompt without changing the model.`,
  {
    name: z.string().describe('Name of the agent to update'),
    system_prompt: z.string().optional().describe('New system prompt (omit to keep current)'),
    model: z.string().optional().describe('New OpenRouter model ID — MUST be provided by the user if changing'),
    mcp_servers: z.array(z.object({
      name: z.string(),
      transport: z.enum(['stdio', 'sse', 'streamable-http']),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      url: z.string().optional(),
      env: z.record(z.string()).optional(),
    })).optional().describe('Replace MCP servers list (omit to keep current)'),
  },
  async (args) => {
    if (!isOrchestrator) {
      return {
        content: [{ type: 'text' as const, text: 'Only the orchestrator can update agents.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'update_agent',
      name: args.name,
      system_prompt: args.system_prompt,
      model: args.model,
      mcp_servers: args.mcp_servers,
      sourceAgent: agentId,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Agent "${args.name}" update requested.`,
      }],
    };
  },
);

// ── delete_agent ────────────────────────────────────────────────────

server.tool(
  'delete_agent',
  `Delete a specialist agent and all its memories/conversations. Only available to the orchestrator.
This is destructive — the agent's long-term memory will be permanently lost.
Always confirm with the user before deleting.`,
  {
    name: z.string().describe('Name of the agent to delete'),
  },
  async (args) => {
    if (!isOrchestrator) {
      return {
        content: [{ type: 'text' as const, text: 'Only the orchestrator can delete agents.' }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'delete_agent',
      name: args.name,
      sourceAgent: agentId,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{
        type: 'text' as const,
        text: `Agent "${args.name}" deletion requested.`,
      }],
    };
  },
);

// ── list_agents ─────────────────────────────────────────────────────

server.tool(
  'list_agents',
  'List all specialist agents and their configurations.',
  {},
  async () => {
    const agentsFile = path.join(IPC_DIR, 'current_agents.json');

    try {
      if (!fs.existsSync(agentsFile)) {
        return { content: [{ type: 'text' as const, text: 'No specialist agents configured.' }] };
      }

      const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));

      if (agents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No specialist agents configured.' }] };
      }

      const formatted = agents
        .map(
          (a: { name: string; model: string; system_prompt: string; mcp_servers: unknown[] }) =>
            `- **${a.name}** (model: \`${a.model}\`)\n  ${a.system_prompt.slice(0, 120)}${a.system_prompt.length > 120 ? '...' : ''}\n  MCP servers: ${a.mcp_servers?.length || 0} extra`,
        )
        .join('\n\n');

      return { content: [{ type: 'text' as const, text: `Specialist agents:\n\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading agents: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
