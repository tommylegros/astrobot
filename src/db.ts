/**
 * Database layer for Astrobot v2
 * PostgreSQL + pgvector
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import pgvector from 'pgvector/pg';

import { logger } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool;

// ── Initialization ──────────────────────────────────────────────────

export async function initDatabase(connectionString: string): Promise<void> {
  pool = new Pool({ connectionString });

  // Register pgvector type
  const client = await pool.connect();
  try {
    await pgvector.registerTypes(client);
  } finally {
    client.release();
  }

  // Run migrations
  await runMigrations();
  logger.info('Database initialized');
}

async function runMigrations(): Promise<void> {
  // Ensure schema_version table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  const result = await pool.query(
    'SELECT COALESCE(MAX(version), 0) AS current_version FROM schema_version',
  );
  const currentVersion = result.rows[0].current_version as number;

  const migrationsDir = path.join(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
    const version = parseInt(match[1], 10);
    if (version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info({ version, file }, 'Running migration');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT DO NOTHING',
        [version],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Get the raw pool for advanced queries (e.g., from memory MCP) */
export function getPool(): pg.Pool {
  return pool;
}

/** For tests: use an existing pool */
export async function _initTestDatabase(connectionString: string): Promise<void> {
  await initDatabase(connectionString);
}

export async function shutdownDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}

// ── Agent CRUD ──────────────────────────────────────────────────────

export interface AgentRow {
  id: string;
  name: string;
  system_prompt: string;
  model: string;
  mcp_servers: object[];
  container_config: object;
  is_orchestrator: boolean;
  created_at: string;
  updated_at: string;
}

export async function createAgent(agent: {
  name: string;
  system_prompt: string;
  model: string;
  mcp_servers?: object[];
  container_config?: object;
  is_orchestrator?: boolean;
}): Promise<AgentRow> {
  const result = await pool.query(
    `INSERT INTO agents (name, system_prompt, model, mcp_servers, container_config, is_orchestrator)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET
       system_prompt = EXCLUDED.system_prompt,
       model = EXCLUDED.model,
       mcp_servers = EXCLUDED.mcp_servers,
       container_config = EXCLUDED.container_config,
       is_orchestrator = EXCLUDED.is_orchestrator,
       updated_at = now()
     RETURNING *`,
    [
      agent.name,
      agent.system_prompt,
      agent.model,
      JSON.stringify(agent.mcp_servers || []),
      JSON.stringify(agent.container_config || {}),
      agent.is_orchestrator || false,
    ],
  );
  return result.rows[0];
}

export async function getAgentById(id: string): Promise<AgentRow | null> {
  const result = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getAgentByName(name: string): Promise<AgentRow | null> {
  const result = await pool.query('SELECT * FROM agents WHERE name = $1', [name]);
  return result.rows[0] || null;
}

export async function getOrchestratorAgent(): Promise<AgentRow | null> {
  const result = await pool.query(
    'SELECT * FROM agents WHERE is_orchestrator = TRUE LIMIT 1',
  );
  return result.rows[0] || null;
}

export async function getAllAgents(): Promise<AgentRow[]> {
  const result = await pool.query('SELECT * FROM agents ORDER BY name');
  return result.rows;
}

export async function updateAgent(
  id: string,
  updates: Partial<Pick<AgentRow, 'system_prompt' | 'model' | 'mcp_servers' | 'container_config'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.system_prompt !== undefined) {
    fields.push(`system_prompt = $${paramIdx++}`);
    values.push(updates.system_prompt);
  }
  if (updates.model !== undefined) {
    fields.push(`model = $${paramIdx++}`);
    values.push(updates.model);
  }
  if (updates.mcp_servers !== undefined) {
    fields.push(`mcp_servers = $${paramIdx++}`);
    values.push(JSON.stringify(updates.mcp_servers));
  }
  if (updates.container_config !== undefined) {
    fields.push(`container_config = $${paramIdx++}`);
    values.push(JSON.stringify(updates.container_config));
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = now()`);
  values.push(id);

  await pool.query(
    `UPDATE agents SET ${fields.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

export async function deleteAgent(id: string): Promise<void> {
  await pool.query('DELETE FROM agents WHERE id = $1', [id]);
}

// ── Conversations ───────────────────────────────────────────────────

export interface ConversationRow {
  id: string;
  agent_id: string;
  messages: object[];
  started_at: string;
  last_active: string;
  summary: string | null;
  status: 'active' | 'summarized' | 'archived';
}

export async function getActiveConversation(
  agentId: string,
): Promise<ConversationRow | null> {
  const result = await pool.query(
    `SELECT * FROM conversations WHERE agent_id = $1 AND status = 'active' ORDER BY last_active DESC LIMIT 1`,
    [agentId],
  );
  return result.rows[0] || null;
}

export async function createConversation(agentId: string): Promise<ConversationRow> {
  const result = await pool.query(
    `INSERT INTO conversations (agent_id) VALUES ($1) RETURNING *`,
    [agentId],
  );
  return result.rows[0];
}

export async function appendConversationMessages(
  conversationId: string,
  newMessages: object[],
): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET messages = messages || $1::jsonb,
         last_active = now()
     WHERE id = $2`,
    [JSON.stringify(newMessages), conversationId],
  );
}

export async function getConversationMessages(
  conversationId: string,
  limit?: number,
): Promise<object[]> {
  const result = await pool.query(
    'SELECT messages FROM conversations WHERE id = $1',
    [conversationId],
  );
  if (!result.rows[0]) return [];
  const messages = result.rows[0].messages as object[];
  if (limit && messages.length > limit) {
    return messages.slice(-limit);
  }
  return messages;
}

export async function summarizeConversation(
  conversationId: string,
  summary: string,
): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'summarized', summary = $1 WHERE id = $2`,
    [summary, conversationId],
  );
}

export async function archiveConversation(conversationId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations SET status = 'archived' WHERE id = $1`,
    [conversationId],
  );
}

// ── Agent Memories (vector) ─────────────────────────────────────────

export interface MemoryRow {
  id: string;
  agent_id: string;
  content: string;
  memory_type: string;
  metadata: object;
  created_at: string;
}

export async function storeMemory(memory: {
  agent_id: string;
  content: string;
  embedding: number[];
  memory_type?: string;
  metadata?: object;
}): Promise<MemoryRow> {
  const result = await pool.query(
    `INSERT INTO agent_memories (agent_id, content, embedding, memory_type, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, agent_id, content, memory_type, metadata, created_at`,
    [
      memory.agent_id,
      memory.content,
      pgvector.toSql(memory.embedding),
      memory.memory_type || 'conversation_summary',
      JSON.stringify(memory.metadata || {}),
    ],
  );
  return result.rows[0];
}

export async function searchMemories(
  agentId: string,
  queryEmbedding: number[],
  limit: number = 10,
): Promise<(MemoryRow & { similarity: number })[]> {
  const result = await pool.query(
    `SELECT id, agent_id, content, memory_type, metadata, created_at,
            1 - (embedding <=> $1) AS similarity
     FROM agent_memories
     WHERE agent_id = $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [pgvector.toSql(queryEmbedding), agentId, limit],
  );
  return result.rows;
}

export async function getMemoriesForAgent(
  agentId: string,
  limit: number = 50,
): Promise<MemoryRow[]> {
  const result = await pool.query(
    `SELECT id, agent_id, content, memory_type, metadata, created_at
     FROM agent_memories
     WHERE agent_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [agentId, limit],
  );
  return result.rows;
}

// ── Message Log ─────────────────────────────────────────────────────

export async function logMessage(msg: {
  telegram_message_id?: number;
  telegram_chat_id?: number;
  sender: string;
  content: string;
  direction: 'inbound' | 'outbound';
  agent_id?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO message_log (telegram_message_id, telegram_chat_id, sender, content, direction, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      msg.telegram_message_id || null,
      msg.telegram_chat_id || null,
      msg.sender,
      msg.content,
      msg.direction,
      msg.agent_id || null,
    ],
  );
}

// ── Scheduled Tasks ─────────────────────────────────────────────────

export interface TaskRow {
  id: string;
  agent_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export async function createTask(task: {
  agent_id: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run?: string;
}): Promise<TaskRow> {
  const result = await pool.query(
    `INSERT INTO scheduled_tasks (agent_id, prompt, schedule_type, schedule_value, next_run)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [task.agent_id, task.prompt, task.schedule_type, task.schedule_value, task.next_run || null],
  );
  return result.rows[0];
}

export async function getTaskById(id: string): Promise<TaskRow | null> {
  const result = await pool.query('SELECT * FROM scheduled_tasks WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getDueTasks(): Promise<TaskRow[]> {
  const result = await pool.query(
    `SELECT * FROM scheduled_tasks
     WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= now()
     ORDER BY next_run`,
  );
  return result.rows;
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<TaskRow, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'last_run' | 'last_result'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = $${paramIdx++}`);
      values.push(value);
    }
  }

  if (fields.length === 0) return;
  values.push(id);

  await pool.query(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

export async function deleteTask(id: string): Promise<void> {
  await pool.query('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
}

export async function getTasksForAgent(agentId: string): Promise<TaskRow[]> {
  const result = await pool.query(
    'SELECT * FROM scheduled_tasks WHERE agent_id = $1 ORDER BY created_at DESC',
    [agentId],
  );
  return result.rows;
}

export async function getAllTasks(): Promise<TaskRow[]> {
  const result = await pool.query(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  return result.rows;
}

// ── Orchestrator State ──────────────────────────────────────────────

export async function getState(key: string): Promise<unknown | null> {
  const result = await pool.query(
    'SELECT value FROM orchestrator_state WHERE key = $1',
    [key],
  );
  return result.rows[0]?.value ?? null;
}

export async function setState(key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO orchestrator_state (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

// ── MCP Server Registry (DB-backed) ────────────────────────────────

export interface MCPServerRow {
  id: string;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  scope: 'global' | 'agent';
  enabled: boolean;
  created_at: string;
}

export async function getMCPServers(scope?: 'global' | 'agent'): Promise<MCPServerRow[]> {
  if (scope) {
    const result = await pool.query(
      'SELECT * FROM mcp_servers WHERE scope = $1 AND enabled = TRUE ORDER BY name',
      [scope],
    );
    return result.rows;
  }
  const result = await pool.query(
    'SELECT * FROM mcp_servers WHERE enabled = TRUE ORDER BY name',
  );
  return result.rows;
}

export async function upsertMCPServer(server: {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  scope?: string;
}): Promise<MCPServerRow> {
  const result = await pool.query(
    `INSERT INTO mcp_servers (name, transport, command, args, url, env, scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET
       transport = EXCLUDED.transport,
       command = EXCLUDED.command,
       args = EXCLUDED.args,
       url = EXCLUDED.url,
       env = EXCLUDED.env,
       scope = EXCLUDED.scope
     RETURNING *`,
    [
      server.name,
      server.transport,
      server.command || null,
      JSON.stringify(server.args || []),
      server.url || null,
      JSON.stringify(server.env || {}),
      server.scope || 'global',
    ],
  );
  return result.rows[0];
}

export async function deleteMCPServer(name: string): Promise<void> {
  await pool.query('DELETE FROM mcp_servers WHERE name = $1', [name]);
}
