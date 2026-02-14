/**
 * Astrobot v2 Configuration
 * All configurable values in one place.
 */
import path from 'path';

// ── Assistant identity ──────────────────────────────────────────────

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Nano';

// ── Polling intervals ───────────────────────────────────────────────

export const POLL_INTERVAL = 2000; // Message loop polling (ms)
export const SCHEDULER_POLL_INTERVAL = 60000; // Task scheduler polling (ms)
export const IPC_POLL_INTERVAL = 1000; // IPC watcher polling (ms)

// ── Paths ───────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// ── Database ────────────────────────────────────────────────────────

// Build DATABASE_URL from POSTGRES_PASSWORD with proper URL encoding.
// This is the primary path — DATABASE_URL is no longer set as an env var.
function buildDatabaseUrl(): string {
  const password = process.env.POSTGRES_PASSWORD || 'astrobot';
  const user = process.env.POSTGRES_USER || 'astrobot';
  const host = process.env.POSTGRES_HOST || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  const db = process.env.POSTGRES_DB || 'astrobot';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

// Computed once at startup from POSTGRES_PASSWORD (or DATABASE_URL env if set directly).
export const DATABASE_URL =
  process.env.DATABASE_URL || buildDatabaseUrl();

// ── OpenRouter ──────────────────────────────────────────────────────

// Can be a direct API key or a 1Password reference (op://...)
export const OPENROUTER_API_KEY_REF =
  process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY_REF || '';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// Default model for the orchestrator agent
export const ORCHESTRATOR_MODEL =
  process.env.ORCHESTRATOR_MODEL || 'anthropic/claude-sonnet-4-20250514';

// Default model for specialist agents (overridable per-agent)
export const DEFAULT_AGENT_MODEL =
  process.env.DEFAULT_AGENT_MODEL || 'anthropic/claude-sonnet-4-20250514';

// Model used for generating embeddings
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || 'openai/text-embedding-3-small';

// ── Telegram ────────────────────────────────────────────────────────

// Can be a direct token or a 1Password reference (op://...)
export const TELEGRAM_BOT_TOKEN_REF =
  process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN_REF || '';

// Owner chat ID — set via env or auto-registered on first message.
// When set, only this chat (and any others added at runtime) can talk to the bot.
export const TELEGRAM_OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID
  ? parseInt(process.env.TELEGRAM_OWNER_CHAT_ID, 10)
  : undefined;

// ── Container (Docker) ──────────────────────────────────────────────

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'astrobot-agent:latest';

// Hard timeout for any container (ms)
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
); // 30min default

// Max stdout/stderr buffer per container (bytes)
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default

// Orchestrator container TTL (ms) — stays alive for conversation continuity
export const ORCHESTRATOR_TTL = parseInt(
  process.env.ORCHESTRATOR_TTL || '28800000',
  10,
); // 8 hours default

// Default specialist agent TTL (ms)
export const DEFAULT_AGENT_TTL = parseInt(
  process.env.DEFAULT_AGENT_TTL || '1800000',
  10,
); // 30min default

// Idle timeout — close container after this long with no output
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default

// Max concurrent containers
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Docker socket path
export const DOCKER_SOCKET =
  process.env.DOCKER_SOCKET || '/var/run/docker.sock';

// ── Timezone ────────────────────────────────────────────────────────

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
