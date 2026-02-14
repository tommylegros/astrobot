/**
 * Astrobot Agent Runner v2
 * Runs inside a Docker container, uses OpenRouter for LLM calls.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON
 *   IPC:   Follow-up messages via /workspace/ipc/input/*.json
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Output protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

interface MediaAttachment {
  type: 'image';
  path: string;
  mimeType: string;
}

interface ContainerInput {
  prompt: string;
  media?: MediaAttachment[];
  agentId: string;
  agentName: string;
  model: string;
  systemPrompt: string;
  conversationId?: string;
  isOrchestrator: boolean;
  mcpServers: MCPServerConfig[];
  secrets?: Record<string, string>;
}

interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  conversationId?: string;
  error?: string;
}

interface MCPToolInfo {
  client: Client;
  serverName: string;
  name: string;
  description: string;
  inputSchema: object;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---ASTROBOT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---ASTROBOT_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ── Stdin reading ───────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ── IPC helpers ─────────────────────────────────────────────────────

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

interface IpcMessage {
  text: string;
  media?: Array<{ type: string; path: string; mimeType: string }>;
}

function drainIpcInput(): IpcMessage[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: IpcMessage[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push({ text: data.text, media: data.media });
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Build a multimodal content array for OpenRouter from text and optional media.
 */
function buildMultimodalContent(
  text: string,
  media?: Array<{ type: string; path: string; mimeType: string }>,
): string | Array<{ type: string; text?: string; image_url?: { url: string } }> {
  if (!media || media.length === 0) return text;

  const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];

  // Add text part first
  if (text) {
    parts.push({ type: 'text', text });
  }

  // Add image parts as base64 data URIs
  for (const m of media) {
    if (m.type === 'image') {
      try {
        const imageData = fs.readFileSync(m.path);
        const base64 = imageData.toString('base64');
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${m.mimeType};base64,${base64}` },
        });
        log(`Attached image: ${m.path} (${imageData.length} bytes)`);
      } catch (err) {
        log(`Failed to read image ${m.path}: ${err instanceof Error ? err.message : String(err)}`);
        parts.push({ type: 'text', text: `[Failed to load image: ${m.path}]` });
      }
    }
  }

  return parts.length === 1 && parts[0].type === 'text' ? (parts[0].text || text) : parts;
}

function waitForIpcMessage(): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        // Combine multiple text messages but keep media from all
        const combinedText = messages.map(m => m.text).join('\n');
        const combinedMedia = messages.flatMap(m => m.media || []);
        resolve({
          text: combinedText,
          media: combinedMedia.length > 0 ? combinedMedia : undefined,
        });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// ── MCP Client Management ───────────────────────────────────────────

async function connectMCPServers(
  configs: MCPServerConfig[],
): Promise<{ tools: MCPToolInfo[]; clients: Client[] }> {
  const tools: MCPToolInfo[] = [];
  const clients: Client[] = [];

  for (const config of configs) {
    if (config.transport !== 'stdio' || !config.command) {
      log(`Skipping MCP server ${config.name}: only stdio transport supported in container`);
      continue;
    }

    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
      });

      const client = new Client({
        name: `astrobot-agent-${config.name}`,
        version: '2.0.0',
      });

      await client.connect(transport);
      clients.push(client);

      // List tools from this server
      const toolList = await client.listTools();
      for (const tool of toolList.tools) {
        tools.push({
          client,
          serverName: config.name,
          name: `${config.name}__${tool.name}`,
          description: tool.description || '',
          inputSchema: tool.inputSchema,
        });
      }

      log(`Connected MCP server: ${config.name} (${toolList.tools.length} tools)`);
    } catch (err) {
      log(`Failed to connect MCP server ${config.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { tools, clients };
}

function mcpToolsToOpenAI(mcpTools: MCPToolInfo[]): ChatCompletionTool[] {
  return mcpTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

async function callMCPTool(
  tools: MCPToolInfo[],
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  // Extract the actual tool name (without server prefix)
  const actualName = toolName.includes('__')
    ? toolName.split('__').slice(1).join('__')
    : toolName;

  try {
    const result = await tool.client.callTool({
      name: actualName,
      arguments: args,
    });

    // Extract text content from MCP result
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { type: string; text?: string }) => c.text || '')
        .join('\n');
    }

    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({
      error: `Tool call failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ── Agent Loop ──────────────────────────────────────────────────────

async function runAgentLoop(
  openai: OpenAI,
  model: string,
  systemPrompt: string,
  messages: ChatCompletionMessageParam[],
  mcpTools: MCPToolInfo[],
): Promise<{ response: string; updatedMessages: ChatCompletionMessageParam[] }> {
  const openaiTools = mcpToolsToOpenAI(mcpTools);
  const maxIterations = 50; // Safety limit for tool call loops

  for (let i = 0; i < maxIterations; i++) {
    log(`Agent loop iteration ${i + 1}, messages: ${messages.length}`);

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      temperature: 0.7,
    });

    const choice = completion.choices[0];
    if (!choice) {
      return { response: 'No response from model', updatedMessages: messages };
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // If no tool calls, we're done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return {
        response: assistantMessage.content || '',
        updatedMessages: messages,
      };
    }

    // Execute tool calls
    for (const toolCall of assistantMessage.tool_calls) {
      log(`Tool call: ${toolCall.function.name}`);

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      const result = await callMCPTool(mcpTools, toolCall.function.name, args);

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // Check for IPC messages during tool execution
    const ipcMessages = drainIpcInput();
    for (const ipcMsg of ipcMessages) {
      log(`IPC message during tool loop: ${ipcMsg.text.length} chars, media: ${ipcMsg.media?.length || 0}`);
      const ipcContent = buildMultimodalContent(ipcMsg.text, ipcMsg.media);
      messages.push({ role: 'user', content: ipcContent as string });
    }
  }

  log('Max iterations reached in agent loop');
  return {
    response: 'Agent reached maximum iteration limit.',
    updatedMessages: messages,
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Clean up temp file if it exists
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for agent: ${containerInput.agentName} (${containerInput.agentId})`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Initialize OpenRouter client
  const apiKey = containerInput.secrets?.OPENROUTER_API_KEY;
  if (!apiKey) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'OPENROUTER_API_KEY not provided in secrets',
    });
    process.exit(1);
  }

  // Expose secrets as env vars so MCP child processes can access them
  if (containerInput.secrets) {
    for (const [key, value] of Object.entries(containerInput.secrets)) {
      process.env[key] = value;
    }
  }

  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  });

  // Connect MCP servers
  const { tools: mcpTools, clients: mcpClients } = await connectMCPServers(
    containerInput.mcpServers,
  );
  log(`Total MCP tools available: ${mcpTools.length}`);

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean stale close sentinel
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial conversation
  const messages: ChatCompletionMessageParam[] = [];

  // Add initial prompt (with optional media for multimodal input)
  let prompt = containerInput.prompt;
  let initialMedia: Array<{ type: string; path: string; mimeType: string }> | undefined =
    containerInput.media?.map(m => ({
      type: m.type as string,
      path: m.path,
      mimeType: m.mimeType,
    }));

  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.map(p => p.text).join('\n');
    // Merge media from pending messages
    const pendingMedia = pending.flatMap(p => p.media || []);
    if (pendingMedia.length > 0) {
      initialMedia = [...(initialMedia || []), ...pendingMedia];
    }
  }

  const initialContent = buildMultimodalContent(prompt, initialMedia);
  messages.push({ role: 'user', content: initialContent as string });

  // Query loop: run agent → wait for IPC message → run again → repeat
  try {
    while (true) {
      log(`Starting agent loop (model: ${containerInput.model}, messages: ${messages.length})...`);

      const { response, updatedMessages } = await runAgentLoop(
        openai,
        containerInput.model,
        containerInput.systemPrompt,
        messages,
        mcpTools,
      );

      // Update messages reference
      messages.length = 0;
      messages.push(...updatedMessages);

      // Emit result
      writeOutput({
        status: 'success',
        result: response || null,
        conversationId: containerInput.conversationId,
      });

      // Check if close was signaled during the loop
      if (shouldClose()) {
        log('Close sentinel detected, exiting');
        break;
      }

      log('Agent loop complete, waiting for next IPC message...');

      // Wait for next message or close
      const nextIpc = await waitForIpcMessage();
      if (nextIpc === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextIpc.text.length} chars, media: ${nextIpc.media?.length || 0}), continuing conversation`);
      const nextContent = buildMultimodalContent(nextIpc.text, nextIpc.media);
      messages.push({ role: 'user', content: nextContent as string });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      conversationId: containerInput.conversationId,
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    // Disconnect MCP clients
    for (const client of mcpClients) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }
}

main();
