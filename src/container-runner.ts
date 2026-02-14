/**
 * Docker Container Runner for Astrobot v2
 *
 * Spawns agent execution in Docker containers using dockerode.
 * Each agent gets an isolated container with IPC volume mounts.
 */
import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';
import { Writable, PassThrough } from 'stream';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  DOCKER_SOCKET,
  IDLE_TIMEOUT,
  ORCHESTRATOR_TTL,
} from './config.js';
import { getContainerSecrets } from './credentials.js';
import { logger } from './logger.js';
import { ContainerInput, ContainerOutput, MCPServerConfig } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---ASTROBOT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---ASTROBOT_OUTPUT_END---';

let docker: Docker;

export function initDocker(): void {
  docker = new Docker({ socketPath: DOCKER_SOCKET });
  logger.info({ socket: DOCKER_SOCKET }, 'Docker client initialized');
}

/**
 * Check Docker is available and clean up orphaned containers.
 */
export async function ensureDockerReady(): Promise<void> {
  try {
    await docker.ping();
    logger.debug('Docker daemon is reachable');
  } catch (err) {
    throw new Error(
      `Docker is not available at ${DOCKER_SOCKET}. Ensure Docker is running.`,
    );
  }

  // Clean up orphaned Astrobot containers from previous runs
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['astrobot=true'] },
    });
    const orphans = containers.filter(
      (c) => c.State === 'running' || c.State === 'created',
    );
    for (const orphan of orphans) {
      try {
        const container = docker.getContainer(orphan.Id);
        await container.stop({ t: 5 });
        await container.remove({ force: true });
      } catch {
        /* already stopped/removed */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length },
        'Cleaned up orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

interface RunAgentOptions {
  input: ContainerInput;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

/**
 * Run an agent in a Docker container.
 *
 * Protocol:
 * - Input: JSON written to container stdin
 * - Output: JSON wrapped in OUTPUT_START/END markers on stdout
 * - IPC: File-based via mounted volumes
 */
export async function runContainerAgent(
  options: RunAgentOptions,
): Promise<ContainerOutput> {
  const { input, onOutput } = options;
  const startTime = Date.now();

  // Prepare IPC directories — must be world-writable so the non-root agent
  // container (runs as UID 1000 "node") can read/write/delete files in them.
  const agentIpcDir = path.join(DATA_DIR, 'ipc', input.agentId);
  for (const sub of ['messages', 'tasks', 'input']) {
    const dir = path.join(agentIpcDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o777); } catch { /* best effort */ }
  }

  // Clean stale close sentinel
  const closeSentinel = path.join(agentIpcDir, 'input', '_close');
  try {
    fs.unlinkSync(closeSentinel);
  } catch {
    /* doesn't exist */
  }

  // Prepare agent workspace
  const agentWorkDir = path.join(DATA_DIR, 'workspaces', input.agentId);
  fs.mkdirSync(agentWorkDir, { recursive: true });

  const safeName = input.agentName.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `astrobot-${safeName}-${Date.now()}`;

  // Resolve secrets
  const secrets = await getContainerSecrets();
  input.secrets = secrets;

  // Determine timeout based on agent type
  const isOrchestrator = input.isOrchestrator;
  const configTimeout = isOrchestrator ? ORCHESTRATOR_TTL : CONTAINER_TIMEOUT;
  const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

  logger.info(
    {
      agentName: input.agentName,
      containerName,
      isOrchestrator,
      timeoutMs,
    },
    'Spawning container agent',
  );

  // Build container configuration
  // When running inside Docker (via docker-compose), bind mount paths must
  // reference the HOST filesystem, not the container's. HOST_PROJECT_DIR is
  // set by docker-compose to ${PWD} (the host project root).
  const hostProjectDir = process.env.HOST_PROJECT_DIR || process.cwd();
  const hostDataDir = path.join(hostProjectDir, 'data');
  const hostIpcDir = path.join(hostDataDir, 'ipc', input.agentId);
  const hostWorkDir = path.join(hostDataDir, 'workspaces', input.agentId);

  const binds = [
    `${hostIpcDir}:/workspace/ipc`,
    `${hostWorkDir}:/workspace/agent`,
  ];

  // Environment variables for the container
  const env = [
    `ASTROBOT_AGENT_ID=${input.agentId}`,
    `ASTROBOT_AGENT_NAME=${input.agentName}`,
    `ASTROBOT_IS_ORCHESTRATOR=${input.isOrchestrator ? '1' : '0'}`,
  ];

  try {
    const container = await docker.createContainer({
      Image: CONTAINER_IMAGE,
      name: containerName,
      Labels: { astrobot: 'true', agent: input.agentName },
      Env: env,
      HostConfig: {
        Binds: binds,
        AutoRemove: true,
        NetworkMode: 'host', // Allow access to host Postgres
      },
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
    });

    // Attach to container streams
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });

    // Start the container
    await container.start();

    // Write input to stdin
    const inputJson = JSON.stringify(input);
    stream.write(inputJson);
    stream.end();

    // Remove secrets from input for logging
    delete input.secrets;

    return new Promise<ContainerOutput>((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let timedOut = false;
      let hadStreamingOutput = false;
      let newSessionId: string | undefined;
      let outputChain = Promise.resolve();

      // Parse streaming output
      let parseBuffer = '';

      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();

      // Demux Docker stream (header-prefixed multiplexed stream)
      docker.modem.demuxStream(stream, stdoutStream, stderrStream);

      stdoutStream.on('data', (data: Buffer) => {
        const chunk = data.toString();

        // Accumulate for logging
        if (!stdoutTruncated) {
          const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
          if (chunk.length > remaining) {
            stdout += chunk.slice(0, remaining);
            stdoutTruncated = true;
            logger.warn(
              { agent: input.agentName, size: stdout.length },
              'Container stdout truncated',
            );
          } else {
            stdout += chunk;
          }
        }

        // Stream-parse for output markers
        if (onOutput) {
          parseBuffer += chunk;
          let startIdx: number;
          while (
            (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
          ) {
            const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
            if (endIdx === -1) break;

            const jsonStr = parseBuffer
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
            parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

            try {
              const parsed: ContainerOutput = JSON.parse(jsonStr);
              if (parsed.conversationId) {
                newSessionId = parsed.conversationId;
              }
              hadStreamingOutput = true;
              resetTimeout();
              outputChain = outputChain.then(() => onOutput(parsed));
            } catch (err) {
              logger.warn(
                { agent: input.agentName, error: err },
                'Failed to parse streamed output',
              );
            }
          }
        }
      });

      stderrStream.on('data', (data: Buffer) => {
        const chunk = data.toString();
        const lines = chunk.trim().split('\n');
        for (const line of lines) {
          if (line) logger.debug({ container: input.agentName }, line);
        }
        stderr += chunk.slice(0, CONTAINER_MAX_OUTPUT_SIZE - stderr.length);
      });

      // Timeout handling
      const killOnTimeout = async () => {
        timedOut = true;
        logger.error(
          { agent: input.agentName, containerName },
          'Container timeout, stopping',
        );
        try {
          await container.stop({ t: 10 });
        } catch {
          try {
            await container.kill();
          } catch {
            /* already dead */
          }
        }
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      // Wait for container to finish
      container.wait().then(async (result) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;
        const code = result.StatusCode;

        if (timedOut) {
          if (hadStreamingOutput) {
            logger.info(
              { agent: input.agentName, duration, code },
              'Container timed out after output (idle cleanup)',
            );
            await outputChain;
            resolve({ status: 'success', result: null, conversationId: newSessionId });
          } else {
            resolve({
              status: 'error',
              result: null,
              error: `Container timed out after ${configTimeout}ms`,
            });
          }
          return;
        }

        if (code !== 0) {
          logger.error(
            { agent: input.agentName, code, duration, stderr: stderr.slice(-500) },
            'Container exited with error',
          );
          resolve({
            status: 'error',
            result: null,
            error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
          });
          return;
        }

        // Streaming mode: wait for output chain
        if (onOutput) {
          await outputChain;
          logger.info(
            { agent: input.agentName, duration, conversationId: newSessionId },
            'Container completed (streaming)',
          );
          resolve({ status: 'success', result: null, conversationId: newSessionId });
          return;
        }

        // Non-streaming: parse last output marker
        try {
          const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
          const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

          let jsonLine: string;
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            jsonLine = stdout
              .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
              .trim();
          } else {
            const lines = stdout.trim().split('\n');
            jsonLine = lines[lines.length - 1];
          }

          const output: ContainerOutput = JSON.parse(jsonLine);
          logger.info(
            { agent: input.agentName, duration, status: output.status },
            'Container completed',
          );
          resolve(output);
        } catch (err) {
          logger.error(
            { agent: input.agentName, stdout: stdout.slice(-500), error: err },
            'Failed to parse container output',
          );
          resolve({
            status: 'error',
            result: null,
            error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }).catch((err) => {
        clearTimeout(timeout);
        logger.error(
          { agent: input.agentName, error: err },
          'Container wait error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container error: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    });
  } catch (err) {
    // Remove secrets before logging
    delete input.secrets;
    logger.error(
      { agent: input.agentName, error: err },
      'Failed to create container',
    );
    return {
      status: 'error',
      result: null,
      error: `Failed to create container: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Send a follow-up message to an active agent container via IPC.
 */
export function sendIpcMessage(agentId: string, text: string): boolean {
  const inputDir = path.join(DATA_DIR, 'ipc', agentId, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    try { fs.chmodSync(inputDir, 0o777); } catch { /* best effort */ }
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }), { mode: 0o666 });
    fs.renameSync(tempPath, filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal an agent container to wind down.
 */
export function closeAgentContainer(agentId: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', agentId, 'input');
  try {
    fs.mkdirSync(inputDir, { recursive: true });
    try { fs.chmodSync(inputDir, 0o777); } catch { /* best effort */ }
    fs.writeFileSync(path.join(inputDir, '_close'), '', { mode: 0o666 });
  } catch {
    // ignore
  }
}
