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
  /** Assistant messages: what the turn cost, as LM Studio measured it. */
  stats?: ReplyStats
}

/**
 * LM Studio's own numbers for one turn, from its final `chat.end` event.
 * Token counts cover the whole turn (every tool round), not just the last
 * message, so a turn that read a lot of tool output shows it here.
 */
export interface ReplyStats {
  inputTokens: number
  outputTokens: number
  /** Of outputTokens, how many were reasoning: the cost of "thinking". */
  reasoningTokens: number
  tokensPerSecond: number
  /** Seconds before the first token: prompt reading, or a wait in LM Studio's queue. */
  firstTokenSeconds: number
  /** The reply ran into the Settings output cap and was cut off there. */
  capped?: boolean
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
  /** Per-chat memory switch; null inherits the Settings default (memoryDefault). */
  memory?: boolean | null
  /**
   * Which saved memories this chat injects, by id; null/undefined means
   * automatic (the newest ones that fit the budget). An id no longer saved
   * is just skipped, so this never needs cleaning up by hand.
   */
  memorySelection?: string[] | null
  /** Starred chats sort to the top of the list. */
  starred?: boolean
  /** Which folder this chat is filed under; null/undefined means none. */
  folderId?: string | null
  /**
   * While true, nothing about this chat is written to disk: not its
   * messages, not its name (usually a snippet of the first one), no meta
   * changes at all. Turning it on discards whatever was already saved for
   * it; turning it off saves everything held in memory since, in one go.
   */
  temporary?: boolean
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
  /** Whether a chat with no memory setting of its own uses memory. */
  memoryDefault: 'on' | 'off'
  /**
   * The model for work no one is waiting on -- summarizing long threads --
   * so a small, fast model can do it while the main one stays free for
   * chats. Blank uses the chat model.
   */
  backgroundModel: string
  /**
   * Most tokens a reply may run to (reasoning included) before LM Studio
   * stops it; a runaway answer otherwise ties the model up for many
   * minutes. Blank or 0 means no cap.
   */
  maxOutputTokens: string
  /**
   * After a chat's first reply, have the model write it a short title from
   * what was actually said, instead of the opening words of your message.
   * A title you typed yourself is never overwritten.
   */
  autoTitle: 'on' | 'off'
}

/** One saved memory, as the memory MCP server stores it (see server/memory.ts). */
export interface Memory {
  id: string
  text: string
  createdAt: number
  updatedAt: number
}

/** A named group chats can be filed under, for the conversation list. */
export interface Folder {
  id: string
  name: string
  createdAt: number
  /**
   * Defaults for chats filed here, each overriding the Settings default and
   * overridden by a chat's own setting. Reasoning: a level, or null/'' to
   * inherit. Tools: a plugin-id list like Settings' -- '' is "none" and
   * null is inherit, which differ: a folder for plain conversation can turn
   * the tools off outright.
   */
  reasoning?: string | null
  mcpTools?: string | null
}

/** What a client may change about a folder; a field left out stays as it is. */
export interface FolderUpdate {
  name?: string
  reasoning?: string | null
  mcpTools?: string | null
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
  result?: {
    response_id?: string
    stats?: {
      input_tokens?: number
      total_output_tokens?: number
      reasoning_output_tokens?: number
      tokens_per_second?: number
      time_to_first_token_seconds?: number
    }
  }
}
