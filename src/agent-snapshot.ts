/**
 * Agent Snapshot Writer
 *
 * Writes a JSON snapshot of all specialist agents to the orchestrator's
 * IPC directory so the container can read it via the list_agents MCP tool.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAllAgents, getOrchestratorAgent } from './db.js';

/**
 * Write a snapshot of all specialist agents to the orchestrator's IPC directory.
 */
export async function writeAgentsSnapshot(): Promise<void> {
  const orchestrator = await getOrchestratorAgent();
  if (!orchestrator) return;

  const allAgents = await getAllAgents();
  const specialists = allAgents
    .filter((a) => !a.is_orchestrator)
    .map((a) => ({
      name: a.name,
      model: a.model,
      system_prompt: a.system_prompt,
      mcp_servers: a.mcp_servers,
      created_at: a.created_at,
      updated_at: a.updated_at,
    }));

  const ipcDir = path.join(DATA_DIR, 'ipc', orchestrator.id);
  fs.mkdirSync(ipcDir, { recursive: true });

  const agentsFile = path.join(ipcDir, 'current_agents.json');
  const tempPath = `${agentsFile}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(specialists, null, 2));
  fs.renameSync(tempPath, agentsFile);
}
