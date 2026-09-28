/** Shared domain types. */

export type MessageRole = 'user' | 'assistant' | 'reasoning' | 'tool' | 'error'

/** One entry in a conversation thread. */
export interface Message {
  id: string | number
  role: MessageRole
  /** Absent on tool messages, which carry `output` instead. */
  text?: string
  /** True while tokens are still arriving. */
  streaming?: boolean
  /** Assistant messages: which model answered, and how long it took. */
  model?: string
  /** The specific LM Studio instance, e.g. "qwen/qwen3.8-27b:3". */
  instance?: string
  elapsed?: string
  /** Tool messages. */
  name?: string
  /** Which MCP server provided the tool, e.g. "mcp/astrology-v2". */
  plugin?: string
  output?: string
  failed?: boolean
  /**
   * LM Studio's handle for this reply. Kept per message, not just per
   * conversation, so one failed turn cannot sever the whole context chain.
   */
  responseId?: string
}

export interface Conversation {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /** LM Studio's server-side context handle for this thread. */
  responseId: string | null
  /** Per-chat override; null inherits the Settings default. */
  reasoning?: string | null
  /** Older turns folded into a summary, so they aren't replayed verbatim. */
  summary?: ContextSummary | null
  /** How many messages the server holds. Set on chats it sends in the list. */
  messageCount?: number
  /**
   * True when `messages` was left out of the chat list to keep it small --
   * only the open chat's messages are sent. Fetch the chat to fill them in.
   * Never stored: it describes a copy sent over the wire.
   */
  messagesOmitted?: boolean
}

/**
 * A model-written digest of a conversation's earlier turns. Everything up to
 * and including the message `through` is represented by `text`; later
 * messages are replayed as they are.
 */
export interface ContextSummary {
  text: string
  through: string | number
}

/** A conversation without its messages: what changes when it's renamed, etc. */
export type ConversationMeta = Omit<Conversation, 'messages'>

export const metaOf = (c: Conversation): ConversationMeta => {
  const { messages: _messages, ...meta } = c
  return meta
}

export interface ConversationStore {
  items: Conversation[]
  activeId: string | null
}

export interface Settings {
  url: string
  model: string
  apiToken: string
  systemPrompt: string
  mcpTools: string
  contextLength: string
  reasoning: string
  stallSeconds: string
  /**
   * Characters of prior conversation replayed to the model each turn.
   * Generous by default: this is a local model, so tokens are cheap.
   */
  historyChars: string
  /**
   * Replies the app lets LM Studio work on at once; more wait their turn in
   * the app. Match the model's "parallel" load setting. 0 means no cap.
   */
  parallel: string
}

/** Settings that live on the server, since the server now drives the chat. */
export interface ServerConfig {
  lmStudioUrl: string
  /** Never sent to the browser; the client only learns whether one is set. */
  apiToken: string
  model: string
  systemPrompt: string
  mcpTools: string
  contextLength: string
  reasoning: string
  stallSeconds: string
  /**
   * Characters of prior conversation replayed to the model each turn.
   * Generous by default: this is a local model, so tokens are cheap.
   */
  historyChars: string
  /**
   * Replies the app lets LM Studio work on at once; more wait their turn in
   * the app. Match the model's "parallel" load setting. 0 means no cap.
   */
  parallel: string
}

/** What the browser is allowed to see of the config. */
export type PublicConfig = Omit<ServerConfig, 'apiToken'> & { hasToken: boolean }

export interface Status {
  state: '' | 'pending' | 'live'
  text: string
}

export interface Integration {
  type: 'plugin'
  id: string
}

/** Result of probing /v1/models. */
export interface ConnectionResult {
  ok: boolean
  models: string[]
  error: string | null
}

export interface ReasoningLevel {
  value: string
  label: string
}

/** Reasoning capability read from a model's LM Studio manifest. */
export interface ModelConfig {
  found: boolean
  model?: string
  reasoning: { default: string | null; options: ReasoningLevel[] } | null
  thinking: { default: boolean } | null
}

/** Server-sent events emitted by /api/v1/chat. */
export interface ChatEvent {
  type?: string
  content?: string
  tool?: string
  /** tool_call.name carries the name here, not in `tool`. */
  tool_name?: string
  provider_info?: { type?: string; plugin_id?: string }
  output?: unknown
  reason?: string
  progress?: number
  model_instance_id?: string
  metadata?: { tool_name?: string }
  error?: { message?: string }
  result?: { response_id?: string }
}
