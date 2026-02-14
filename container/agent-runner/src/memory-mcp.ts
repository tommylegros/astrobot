/**
 * Memory MCP Server for Astrobot v2
 *
 * Provides agents with long-term memory via PostgreSQL + pgvector.
 * Each agent has isolated memory that persists across conversations.
 *
 * Tools:
 * - remember: Store a memory with vector embedding
 * - recall: Search memories by semantic similarity
 * - get_conversation_history: Retrieve current conversation messages
 * - clear_conversation: Summarize current conversation, embed it, start fresh
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pg from 'pg';
import pgvector from 'pgvector/pg';
import OpenAI from 'openai';

const { Pool } = pg;

const agentId = process.env.ASTROBOT_AGENT_ID!;
const databaseUrl = process.env.DATABASE_URL!;

let pool: pg.Pool;
let openai: OpenAI | null = null;

async function getPool(): Promise<pg.Pool> {
  if (pool) return pool;
  pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await pgvector.registerTypes(client);
  } finally {
    client.release();
  }
  return pool;
}

function getOpenAI(): OpenAI {
  if (openai) return openai;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not available for embedding generation');
  }
  openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });
  return openai;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAI();
  const model = process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small';
  const response = await client.embeddings.create({
    model,
    input: text,
  });
  return response.data[0].embedding;
}

const server = new McpServer({
  name: 'astrobot-memory',
  version: '2.0.0',
});

// ── remember ────────────────────────────────────────────────────────

server.tool(
  'remember',
  `Store something in your long-term memory. This persists across conversations and container restarts.
Use this to remember important facts, user preferences, decisions, or anything you might need later.
Memories are searchable by semantic similarity, so write clear, descriptive content.`,
  {
    content: z.string().describe('What to remember. Be specific and descriptive.'),
    memory_type: z.enum(['fact', 'preference', 'decision', 'conversation_summary', 'note'])
      .default('note')
      .describe('Category of the memory'),
  },
  async (args) => {
    try {
      const db = await getPool();
      const embedding = await generateEmbedding(args.content);

      await db.query(
        `INSERT INTO agent_memories (agent_id, content, embedding, memory_type, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          agentId,
          args.content,
          pgvector.toSql(embedding),
          args.memory_type,
          JSON.stringify({ stored_at: new Date().toISOString() }),
        ],
      );

      return { content: [{ type: 'text' as const, text: 'Memory stored successfully.' }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to store memory: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── recall ──────────────────────────────────────────────────────────

server.tool(
  'recall',
  `Search your long-term memory for relevant information.
Returns memories ranked by semantic similarity to your query.
Use this when you need to remember something from a previous conversation or check stored facts.`,
  {
    query: z.string().describe('What to search for in memory'),
    limit: z.number().min(1).max(20).default(5).describe('Maximum number of memories to return'),
  },
  async (args) => {
    try {
      const db = await getPool();
      const queryEmbedding = await generateEmbedding(args.query);

      const result = await db.query(
        `SELECT content, memory_type, metadata, created_at,
                1 - (embedding <=> $1) AS similarity
         FROM agent_memories
         WHERE agent_id = $2
         ORDER BY embedding <=> $1
         LIMIT $3`,
        [pgvector.toSql(queryEmbedding), agentId, args.limit],
      );

      if (result.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No relevant memories found.' }] };
      }

      const formatted = result.rows
        .map((row, i) => {
          const date = new Date(row.created_at).toLocaleDateString();
          const sim = (row.similarity * 100).toFixed(1);
          return `${i + 1}. [${row.memory_type}] (${sim}% match, ${date})\n   ${row.content}`;
        })
        .join('\n\n');

      return {
        content: [{ type: 'text' as const, text: `Found ${result.rows.length} memories:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to search memories: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── get_conversation_history ────────────────────────────────────────

server.tool(
  'get_conversation_history',
  `Retrieve the current active conversation history from the database.
Use this to review what was discussed earlier in this conversation session.`,
  {
    limit: z.number().min(1).max(100).default(20).describe('Maximum number of messages to return'),
  },
  async (args) => {
    try {
      const db = await getPool();

      const result = await db.query(
        `SELECT messages, started_at, last_active
         FROM conversations
         WHERE agent_id = $1 AND status = 'active'
         ORDER BY last_active DESC
         LIMIT 1`,
        [agentId],
      );

      if (result.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No active conversation found.' }] };
      }

      const conv = result.rows[0];
      const messages = (conv.messages as Array<{ role: string; content: string }>);
      const recent = messages.slice(-args.limit);

      const formatted = recent
        .map((m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content.slice(0, 500) : JSON.stringify(m.content).slice(0, 500)}`)
        .join('\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Conversation (${messages.length} total messages, showing last ${recent.length}):\n\n${formatted}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get conversation: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── clear_conversation ──────────────────────────────────────────────

server.tool(
  'clear_conversation',
  `Summarize the current conversation, store the summary as a long-term memory, and start a fresh conversation.
Use this when:
- The user sends /clear
- The conversation has gotten too long
- You want to archive the current discussion and start fresh

The summary will be embedded and searchable via the recall tool.`,
  {
    summary: z.string().describe('A concise summary of the conversation to store as a memory'),
  },
  async (args) => {
    try {
      const db = await getPool();

      // Find active conversation
      const convResult = await db.query(
        `SELECT id FROM conversations
         WHERE agent_id = $1 AND status = 'active'
         ORDER BY last_active DESC
         LIMIT 1`,
        [agentId],
      );

      if (convResult.rows.length > 0) {
        const convId = convResult.rows[0].id;

        // Mark as summarized
        await db.query(
          `UPDATE conversations SET status = 'summarized', summary = $1 WHERE id = $2`,
          [args.summary, convId],
        );
      }

      // Store summary as a long-term memory
      try {
        const embedding = await generateEmbedding(args.summary);
        await db.query(
          `INSERT INTO agent_memories (agent_id, content, embedding, memory_type, metadata)
           VALUES ($1, $2, $3, 'conversation_summary', $4)`,
          [
            agentId,
            args.summary,
            pgvector.toSql(embedding),
            JSON.stringify({ cleared_at: new Date().toISOString() }),
          ],
        );
      } catch (embedErr) {
        // Embedding failure shouldn't block conversation clear
        console.error(`[memory-mcp] Failed to embed summary: ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`);
      }

      // Create new active conversation
      await db.query(
        `INSERT INTO conversations (agent_id) VALUES ($1)`,
        [agentId],
      );

      return {
        content: [{
          type: 'text' as const,
          text: 'Conversation cleared. Summary stored in long-term memory. Fresh conversation started.',
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to clear conversation: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
