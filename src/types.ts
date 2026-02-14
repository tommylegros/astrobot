// ── Media types ─────────────────────────────────────────────────────

export interface MediaAttachment {
  type: 'image';
  /** File path (host-side or container-side depending on context) */
  path: string;
  mimeType: string;
  filename?: string;
}

// ── Channel abstraction ─────────────────────────────────────────────

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendPhoto?(chatId: string, photoPath: string, caption?: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
  setTyping?(chatId: string, isTyping: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatId: string, message: InboundMessage) => void;

export interface InboundMessage {
  telegramMessageId: number;
  telegramChatId: number;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  media?: MediaAttachment[];
}

// ── Container types ─────────────────────────────────────────────────

export interface ContainerInput {
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

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  conversationId?: string;
  error?: string;
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// ── Scheduled tasks ─────────────────────────────────────────────────

export interface ScheduledTask {
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
