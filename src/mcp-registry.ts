/**
 * MCP Server Registry for Astrobot v2
 *
 * Manages MCP server configurations that are passed to agent containers.
 * Global servers are available to all agents; agent-scoped servers are
 * configured per-agent in their definition.
 *
 * Built-in servers (IPC, Memory) are always included.
 * External servers are stored in Postgres and can be managed at runtime.
 */
import { getMCPServers, upsertMCPServer, deleteMCPServer, AgentRow } from './db.js';
import { logger } from './logger.js';
import { MCPServerConfig } from './types.js';

/**
 * Get the full list of MCP servers for a given agent.
 * Combines: built-in servers + global DB servers + agent-specific DB servers + agent definition servers
 */
export async function getMCPServersForAgent(
  agent: AgentRow,
  databaseUrl: string,
): Promise<MCPServerConfig[]> {
  const servers: MCPServerConfig[] = [];

  // 1. Built-in IPC MCP server (always included)
  servers.push({
    name: 'astrobot_ipc',
    transport: 'stdio',
    command: 'node',
    args: ['/tmp/dist/ipc-mcp-stdio.js'],
    env: {
      ASTROBOT_AGENT_ID: agent.id,
      ASTROBOT_AGENT_NAME: agent.name,
      ASTROBOT_IS_ORCHESTRATOR: agent.is_orchestrator ? '1' : '0',
    },
  });

  // 2. Built-in Memory MCP server (always included)
  servers.push({
    name: 'astrobot_memory',
    transport: 'stdio',
    command: 'node',
    args: ['/tmp/dist/memory-mcp.js'],
    env: {
      ASTROBOT_AGENT_ID: agent.id,
      DATABASE_URL: databaseUrl,
    },
  });

  // 3. Global MCP servers from database
  try {
    const globalServers = await getMCPServers('global');
    for (const s of globalServers) {
      servers.push({
        name: s.name,
        transport: s.transport,
        command: s.command || undefined,
        args: s.args || [],
        url: s.url || undefined,
        env: s.env || {},
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load global MCP servers from DB');
  }

  // 4. Agent-specific MCP servers from agent definition
  const agentServers = (agent.mcp_servers || []) as MCPServerConfig[];
  for (const s of agentServers) {
    // Don't duplicate built-in servers
    if (!servers.some((existing) => existing.name === s.name)) {
      servers.push(s);
    }
  }

  return servers;
}

/**
 * Register a new MCP server in the database.
 */
export async function registerMCPServer(config: {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  scope?: string;
}): Promise<void> {
  await upsertMCPServer(config);
  logger.info({ name: config.name, scope: config.scope || 'global' }, 'MCP server registered');
}

/**
 * Remove an MCP server from the database.
 */
export async function unregisterMCPServer(name: string): Promise<void> {
  await deleteMCPServer(name);
  logger.info({ name }, 'MCP server unregistered');
}

/**
 * List all registered MCP servers.
 */
export async function listMCPServers(): Promise<MCPServerConfig[]> {
  const servers = await getMCPServers();
  return servers.map((s) => ({
    name: s.name,
    transport: s.transport,
    command: s.command || undefined,
    args: s.args || [],
    url: s.url || undefined,
    env: s.env || {},
  }));
}
