# Astrobot v2

Personal AI assistant with OpenRouter backend, Telegram interface, and specialist agent orchestration.

## Quick Context

Single Node.js process connects to Telegram, routes DM messages to an orchestrator agent running in Docker containers. The orchestrator delegates tasks to specialist agents, each with isolated PostgreSQL-backed memory (pgvector). All tools are provided via MCP servers. Credentials managed via 1Password CLI.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point: startup, Telegram, Docker, orchestrator |
| `src/orchestrator.ts` | Orchestrator logic: message routing, delegation, conversation lifecycle |
| `src/channels/telegram.ts` | Telegram bot (grammy, DM-only) |
| `src/container-runner.ts` | Docker container management (dockerode) |
| `src/db.ts` | PostgreSQL + pgvector database layer |
| `src/credentials.ts` | 1Password CLI wrapper |
| `src/mcp-registry.ts` | MCP server configuration registry |
| `src/embedding.ts` | OpenRouter embedding helper |
| `src/ipc.ts` | IPC watcher for container communication |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/config.ts` | All configuration values |
| `src/router.ts` | Message formatting |
| `src/types.ts` | TypeScript interfaces |
| `container/agent-runner/src/index.ts` | Container-side agent (OpenRouter + MCP) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | IPC MCP server (send_message, delegate, ask_user, manage agents) |
| `container/agent-runner/src/memory-mcp.ts` | Memory MCP server (remember, recall, clear) |
| `src/agent-snapshot.ts` | Writes specialist agent list to IPC for containers |
| `migrations/001_init.sql` | PostgreSQL schema |
| `docker-compose.yml` | VPS deployment |
| `scripts/deploy.sh` | First-time deploy (1Password, credentials, models, build, start) |
| `scripts/update.sh` | Update (pull, rebuild, restart, reconfigure) |

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run typecheck    # Type checking
./container/build.sh # Build agent container image
```

## Deployment

```bash
./scripts/deploy.sh                     # First-time setup (interactive)
./scripts/update.sh                     # Pull + rebuild + restart
./scripts/update.sh --reconfigure       # Change models/credentials
docker compose logs -f astrobot         # Watch logs
```

## Architecture

```
Telegram DM → Host Orchestrator → Docker Container (Orchestrator Agent)
                                    ↓
                                  MCP Tools (IPC, Memory, External)
                                    ↓
                                  Delegate → Docker Container (Specialist Agent)
                                    ↓
                                  Result → Orchestrator → Telegram
```
