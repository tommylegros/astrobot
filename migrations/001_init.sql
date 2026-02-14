-- Astrobot v2 Initial Schema
-- PostgreSQL + pgvector

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Agent definitions (orchestrator + specialists)
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  system_prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  mcp_servers JSONB DEFAULT '[]',
  container_config JSONB DEFAULT '{}',
  is_orchestrator BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Conversations (per-agent, long-lived)
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]',
  started_at TIMESTAMPTZ DEFAULT now(),
  last_active TIMESTAMPTZ DEFAULT now(),
  summary TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'summarized', 'archived'))
);

CREATE INDEX idx_conversations_agent ON conversations(agent_id);
CREATE INDEX idx_conversations_status ON conversations(status);

-- Agent memories (long-term, vector-searchable)
CREATE TABLE agent_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536),
  memory_type TEXT DEFAULT 'conversation_summary',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_memories_agent ON agent_memories(agent_id);

-- Message log (all Telegram messages for audit trail)
CREATE TABLE message_log (
  id BIGSERIAL PRIMARY KEY,
  telegram_message_id BIGINT,
  telegram_chat_id BIGINT,
  sender TEXT,
  content TEXT,
  direction TEXT CHECK (direction IN ('inbound', 'outbound')),
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_message_log_chat ON message_log(telegram_chat_id);
CREATE INDEX idx_message_log_created ON message_log(created_at);

-- Scheduled tasks
CREATE TABLE scheduled_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
  schedule_value TEXT NOT NULL,
  next_run TIMESTAMPTZ,
  last_run TIMESTAMPTZ,
  last_result TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tasks_next_run ON scheduled_tasks(next_run);
CREATE INDEX idx_tasks_status ON scheduled_tasks(status);

-- Orchestrator key-value state
CREATE TABLE orchestrator_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- MCP server registry
CREATE TABLE mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'sse', 'streamable-http')),
  command TEXT,
  args JSONB DEFAULT '[]',
  url TEXT,
  env JSONB DEFAULT '{}',
  scope TEXT DEFAULT 'global' CHECK (scope IN ('global', 'agent')),
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Vector similarity index (created after initial data load for better performance)
-- Using ivfflat; for small datasets, exact search (no index) is fine
-- CREATE INDEX idx_memories_embedding ON agent_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Schema version tracking
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO schema_version (version) VALUES (1);
