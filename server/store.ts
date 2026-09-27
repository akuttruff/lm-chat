import fs from 'node:fs'
import path from 'node:path'
import type { Conversation, ConversationStore, Message, ServerConfig } from '../src/types.ts'

/**
 * Everything durable lives next to the app on disk, so conversations survive
 * a phone losing its storage and are shared between devices.
 */
export interface StoreOptions {
  dir?: string
}

const DEFAULT_CONFIG: ServerConfig = {
  lmStudioUrl: 'http://127.0.0.1:1234',
  apiToken: '',
  model: '',
  systemPrompt: '',
  mcpTools: '',
  contextLength: '',
  reasoning: '',
  stallSeconds: '180',
  historyChars: '24000',
  parallel: '4',
}

const MAX_CONVERSATIONS = 60

let seq = 0
export const newId = (): string => `${Date.now().toString(36)}-${(seq++).toString(36)}`

// Strictly increasing, so two updates in the same millisecond still order
// deterministically. Date.now() alone ties and leaves sorting undefined.
let lastStamp = 0
export function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return lastStamp
}

export function blankConversation(): Conversation {
  return {
    id: newId(),
    name: '',
    createdAt: Date.now(),
    updatedAt: stamp(),
    messages: [],
    responseId: null,
    reasoning: null,
    summary: null,
  }
}

function locate(dir?: string) {
  const dataDir = dir || path.resolve(process.cwd(), '.data')
  return {
    dataDir,
    conversations: path.join(dataDir, 'conversations.json'),
    config: path.join(dataDir, 'config.json'),
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(dataDir: string, file: string, value: unknown): void {
  fs.mkdirSync(dataDir, { recursive: true })
  // Write-then-rename: a crash mid-write leaves the previous file intact
  // rather than a truncated one.
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

const countMessages = (store: ConversationStore | null): number =>
  (store?.items || []).reduce((n, c) => n + (c?.messages?.length || 0), 0)

/**
 * Copy the file aside when a write would drop messages. Conversations are
 * append-mostly, so a shrink is either a deliberate delete or a bug -- and a
 * bug that silently eats history is unrecoverable without this.
 *
 * `savedCount` is what the file on disk holds, tracked in memory: re-reading
 * and parsing a megabyte of JSON on every save to learn it was the single
 * most expensive thing the server did while a reply streamed.
 */
function backupIfShrinking(dataDir: string, file: string, savedCount: number, incoming: ConversationStore): void {
  const incomingCount = countMessages(incoming)
  if (incomingCount >= savedCount || !fs.existsSync(file)) return

  const backupDir = path.join(dataDir, 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const name = `conversations.${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  fs.copyFileSync(file, path.join(backupDir, name))
  console.log(
    `[chats] message count dropped ${savedCount} -> ${incomingCount}; ` +
    `backed up to .data/backups/${name}`,
  )
  const kept = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort()
  for (const old of kept.slice(0, Math.max(0, kept.length - 20))) {
    try { fs.unlinkSync(path.join(backupDir, old)) } catch { /* already gone */ }
  }
}

/** In-memory state with write-through persistence. */
export class Store {
  private paths: ReturnType<typeof locate>
  private conversations: ConversationStore
  private config: ServerConfig
  /** Messages in the file on disk, for the shrink check. */
  private savedCount: number

  constructor(options: StoreOptions = {}) {
    this.paths = locate(options.dir)
    this.conversations = readJson<ConversationStore>(
      this.paths.conversations,
      { items: [], activeId: null },
    )
    this.config = { ...DEFAULT_CONFIG, ...readJson<Partial<ServerConfig>>(this.paths.config, {}) }
    this.savedCount = countMessages(this.conversations)
    if (!this.conversations.items.length) {
      const first = blankConversation()
      this.conversations = { items: [first], activeId: first.id }
    }
  }

  getConversations(): ConversationStore {
    return this.conversations
  }

  get(id: string): Conversation | undefined {
    return this.conversations.items.find((c) => c.id === id)
  }

  private flush(): void {
    backupIfShrinking(this.paths.dataDir, this.paths.conversations, this.savedCount, this.conversations)
    writeJson(this.paths.dataDir, this.paths.conversations, this.conversations)
    this.savedCount = countMessages(this.conversations)
  }

  /** Write the in-memory state to disk now. */
  persist(): void {
    this.flush()
  }

  replaceAll(store: ConversationStore): void {
    this.conversations = store
    this.flush()
  }

  create(): Conversation {
    const current = this.get(this.conversations.activeId ?? '')
    // Don't stack up empty threads, but clear any stale server-side context.
    if (current && current.messages.length === 0) {
      current.responseId = null
      current.updatedAt = stamp()
      this.flush()
      return current
    }
    const fresh = blankConversation()
    this.conversations = {
      activeId: fresh.id,
      items: [fresh, ...this.conversations.items].slice(0, MAX_CONVERSATIONS),
    }
    this.flush()
    return fresh
  }

  setActive(id: string): void {
    if (!this.get(id)) return
    this.conversations.activeId = id
    this.flush()
  }

  /**
   * `touch: false` leaves updatedAt -- and so the chat's place in the list --
   * alone: for bookkeeping the server does in the background.
   */
  patch(id: string, patch: Partial<Conversation>, { touch = true }: { touch?: boolean } = {}): Conversation | undefined {
    const conv = this.get(id)
    if (!conv) return undefined
    Object.assign(conv, patch, touch ? { updatedAt: stamp() } : {})
    this.flush()
    return conv
  }

  /**
   * Replace a conversation's messages wholesale (the engine owns assembly).
   * `persist: false` updates memory only, for the many small steps of a
   * streaming reply; the engine saves periodically and when the turn ends.
   *
   * `touch: false` keeps updatedAt, which orders the chat list. A reply
   * streaming in must not move its chat: with two replying at once, each
   * snapshot re-sorted them and the list flickered between the two orders.
   */
  setMessages(
    id: string,
    messages: Message[],
    { persist = true, touch = true }: { persist?: boolean; touch?: boolean } = {},
  ): void {
    const conv = this.get(id)
    if (!conv) return
    conv.messages = messages
    if (!conv.name) conv.name = deriveName(messages)
    if (touch) conv.updatedAt = stamp()
    if (persist) this.flush()
  }

  remove(id: string): void {
    const items = this.conversations.items.filter((c) => c.id !== id)
    if (!items.length) {
      const fresh = blankConversation()
      this.conversations = { items: [fresh], activeId: fresh.id }
    } else {
      this.conversations = {
        items,
        activeId: this.conversations.activeId === id ? items[0]!.id : this.conversations.activeId,
      }
    }
    this.flush()
  }

  getConfig(): ServerConfig {
    return this.config
  }

  /** The token is never sent to the browser; only whether one is set. */
  getPublicConfig(): Omit<ServerConfig, 'apiToken'> & { hasToken: boolean } {
    const { apiToken, ...rest } = this.config
    return { ...rest, hasToken: Boolean(apiToken) }
  }

  setConfig(patch: Partial<ServerConfig>): ServerConfig {
    this.config = { ...this.config, ...patch }
    writeJson(this.paths.dataDir, this.paths.config, this.config)
    return this.config
  }
}

/** Name a thread from its opening message, the way LM Studio titles a chat. */
export function deriveName(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return ''
  const t = (first.text || '').replace(/\s+/g, ' ').trim()
  return t.length > 42 ? `${t.slice(0, 42).trimEnd()}...` : t
}
