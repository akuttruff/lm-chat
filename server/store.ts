import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import type { Conversation, ConversationStore, Message, MessageRole, ServerConfig } from '../src/types.ts'

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
const BACKUP_KEEP = 20

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
    sqlite: path.join(dataDir, 'lm-chat.sqlite'),
    // Pre-SQLite storage, read only to migrate once.
    legacyConversations: path.join(dataDir, 'conversations.json'),
    legacyConfig: path.join(dataDir, 'config.json'),
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  response_id TEXT,
  reasoning TEXT,
  summary_text TEXT,
  summary_through TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','reasoning','tool','error')),
  text TEXT,
  streaming INTEGER,
  model TEXT,
  instance TEXT,
  elapsed TEXT,
  name TEXT,
  plugin TEXT,
  output TEXT,
  failed INTEGER,
  response_id TEXT,
  PRIMARY KEY (conversation_id, position)
);
CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id = 1), active_id TEXT);
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lm_studio_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:1234',
  api_token TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  mcp_tools TEXT NOT NULL DEFAULT '',
  context_length TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  stall_seconds TEXT NOT NULL DEFAULT '180',
  history_chars TEXT NOT NULL DEFAULT '24000',
  parallel TEXT NOT NULL DEFAULT '4'
);
`

/**
 * Single-process, single-user: WAL buys nothing here and would leave
 * permanent -wal/-shm sidecar files needing the same 0600 treatment as the
 * main file forever. Plain rollback-journal leaves only a transient
 * -journal file, gone once a transaction commits.
 */
function ensureSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 2000')
  db.exec(SCHEMA)
}

interface ConversationRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  response_id: string | null
  reasoning: string | null
  summary_text: string | null
  summary_through: string | null
}

interface MessageRow {
  conversation_id: string
  position: number
  id: string
  role: string
  text: string | null
  streaming: number | null
  model: string | null
  instance: string | null
  elapsed: string | null
  name: string | null
  plugin: string | null
  output: string | null
  failed: number | null
  response_id: string | null
}

interface ConfigRow {
  lm_studio_url: string
  api_token: string
  model: string
  system_prompt: string
  mcp_tools: string
  context_length: string
  reasoning: string
  stall_seconds: string
  history_chars: string
  parallel: string
}

function metaFromRow(row: ConversationRow): Omit<Conversation, 'messages'> {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    responseId: row.response_id,
    reasoning: row.reasoning,
    summary: row.summary_text != null ? { text: row.summary_text, through: row.summary_through! } : null,
  }
}

/** Undefined stays absent (vs. an explicit false/null), same as the JSON it replaces. */
function messageFromRow(row: MessageRow): Message {
  const m: Message = { id: row.id, role: row.role as MessageRole }
  if (row.text != null) m.text = row.text
  if (row.streaming != null) m.streaming = row.streaming === 1
  if (row.model != null) m.model = row.model
  if (row.instance != null) m.instance = row.instance
  if (row.elapsed != null) m.elapsed = row.elapsed
  if (row.name != null) m.name = row.name
  if (row.plugin != null) m.plugin = row.plugin
  if (row.output != null) m.output = row.output
  if (row.failed != null) m.failed = row.failed === 1
  if (row.response_id != null) m.responseId = row.response_id
  return m
}

function messageParams(conversationId: string, position: number, m: Message): SQLInputValue[] {
  return [
    conversationId,
    position,
    String(m.id),
    m.role,
    m.text ?? null,
    m.streaming == null ? null : (m.streaming ? 1 : 0),
    m.model ?? null,
    m.instance ?? null,
    m.elapsed ?? null,
    m.name ?? null,
    m.plugin ?? null,
    m.output ?? null,
    m.failed == null ? null : (m.failed ? 1 : 0),
    m.responseId ?? null,
  ]
}

function configFromRow(row: ConfigRow): ServerConfig {
  return {
    lmStudioUrl: row.lm_studio_url,
    apiToken: row.api_token,
    model: row.model,
    systemPrompt: row.system_prompt,
    mcpTools: row.mcp_tools,
    contextLength: row.context_length,
    reasoning: row.reasoning,
    stallSeconds: row.stall_seconds,
    historyChars: row.history_chars,
    parallel: row.parallel,
  }
}

function pruneBackups(backupDir: string): void {
  const kept = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).sort()
  for (const old of kept.slice(0, Math.max(0, kept.length - BACKUP_KEEP))) {
    try { fs.unlinkSync(path.join(backupDir, old)) } catch { /* already gone */ }
  }
}

/**
 * One-time import from the old conversations.json/config.json, the first
 * time this data dir is opened after the SQLite switch. Builds the database
 * at a temp path and only renames it into place on success, so a crash
 * mid-import never leaves a half-built file at the real path -- which would
 * otherwise stop the migration from ever being retried.
 */
function migrateFromJson(paths: ReturnType<typeof locate>): void {
  const conversations = readJson<ConversationStore>(paths.legacyConversations, { items: [], activeId: null })
  const config = { ...DEFAULT_CONFIG, ...readJson<Partial<ServerConfig>>(paths.legacyConfig, {}) }

  const tmp = `${paths.sqlite}.${process.pid}.tmp`
  try { fs.rmSync(tmp, { force: true }) } catch { /* nothing there yet */ }

  const db = new DatabaseSync(tmp)
  try {
    ensureSchema(db)
    const insertConv = db.prepare(
      'INSERT INTO conversations (id,name,created_at,updated_at,response_id,reasoning,summary_text,summary_through) VALUES (?,?,?,?,?,?,?,?)',
    )
    const insertMsg = db.prepare(
      'INSERT INTO messages (conversation_id,position,id,role,text,streaming,model,instance,elapsed,name,plugin,output,failed,response_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    db.exec('BEGIN')
    for (const conv of conversations.items) {
      insertConv.run(
        conv.id, conv.name, conv.createdAt, conv.updatedAt, conv.responseId, conv.reasoning ?? null,
        conv.summary?.text ?? null, conv.summary ? String(conv.summary.through) : null,
      )
      conv.messages.forEach((m, i) => insertMsg.run(...messageParams(conv.id, i, m)))
    }
    db.prepare('INSERT INTO app_state (id, active_id) VALUES (1, ?)').run(conversations.activeId)
    db.prepare(
      `INSERT INTO config (id, lm_studio_url, api_token, model, system_prompt, mcp_tools, context_length, reasoning, stall_seconds, history_chars, parallel)
       VALUES (1,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      config.lmStudioUrl, config.apiToken, config.model, config.systemPrompt, config.mcpTools,
      config.contextLength, config.reasoning, config.stallSeconds, config.historyChars, config.parallel,
    )
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* nothing to roll back */ }
    db.close()
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw err
  }
  db.close()
  fs.renameSync(tmp, paths.sqlite)

  const messageCount = conversations.items.reduce((n, c) => n + c.messages.length, 0)
  console.log(
    `[chats] migrated ${conversations.items.length} conversations (${messageCount} messages) ` +
    'from conversations.json to lm-chat.sqlite',
  )
  // Renamed, never deleted: a safety net in case anything above was wrong.
  for (const legacy of [paths.legacyConversations, paths.legacyConfig]) {
    if (fs.existsSync(legacy)) {
      try { fs.renameSync(legacy, `${legacy}.migrated`) } catch { /* best effort */ }
    }
  }
}

interface Stmts {
  selectConversations: StatementSync
  selectMessagesFor: StatementSync
  selectConversationById: StatementSync
  selectActiveId: StatementSync
  selectConfig: StatementSync
  insertConversation: StatementSync
  updateConversationMeta: StatementSync
  deleteConversation: StatementSync
  deleteMessagesFor: StatementSync
  insertMessage: StatementSync
  setActiveId: StatementSync
  insertConfig: StatementSync
  updateConfig: StatementSync
}

/** In-memory state with write-through persistence to SQLite. */
export class Store {
  private paths: ReturnType<typeof locate>
  private db: DatabaseSync
  private stmts: Stmts
  private conversations: ConversationStore
  private config: ServerConfig
  /** Messages saved to disk per conversation id, for the shrink check. */
  private savedCounts: Map<string, number>

  constructor(options: StoreOptions = {}) {
    this.paths = locate(options.dir)
    fs.mkdirSync(this.paths.dataDir, { recursive: true })

    const hasLegacyJson = fs.existsSync(this.paths.legacyConversations) || fs.existsSync(this.paths.legacyConfig)
    if (!fs.existsSync(this.paths.sqlite) && hasLegacyJson) {
      migrateFromJson(this.paths)
    }

    this.db = new DatabaseSync(this.paths.sqlite)
    ensureSchema(this.db)
    try { fs.chmodSync(this.paths.sqlite, 0o600) } catch { /* not ours to change */ }

    this.stmts = {
      selectConversations: this.db.prepare('SELECT * FROM conversations'),
      selectMessagesFor: this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY position'),
      selectConversationById: this.db.prepare('SELECT * FROM conversations WHERE id = ?'),
      selectActiveId: this.db.prepare('SELECT active_id FROM app_state WHERE id = 1'),
      selectConfig: this.db.prepare('SELECT * FROM config WHERE id = 1'),
      insertConversation: this.db.prepare(
        'INSERT INTO conversations (id,name,created_at,updated_at,response_id,reasoning,summary_text,summary_through) VALUES (?,?,?,?,?,?,?,?)',
      ),
      updateConversationMeta: this.db.prepare(
        'UPDATE conversations SET name=?, updated_at=?, response_id=?, reasoning=?, summary_text=?, summary_through=? WHERE id=?',
      ),
      deleteConversation: this.db.prepare('DELETE FROM conversations WHERE id = ?'),
      deleteMessagesFor: this.db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
      insertMessage: this.db.prepare(
        'INSERT INTO messages (conversation_id,position,id,role,text,streaming,model,instance,elapsed,name,plugin,output,failed,response_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ),
      setActiveId: this.db.prepare(
        'INSERT INTO app_state (id, active_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET active_id = excluded.active_id',
      ),
      insertConfig: this.db.prepare(
        `INSERT INTO config (id, lm_studio_url, api_token, model, system_prompt, mcp_tools, context_length, reasoning, stall_seconds, history_chars, parallel)
         VALUES (1,?,?,?,?,?,?,?,?,?,?)`,
      ),
      updateConfig: this.db.prepare(
        `UPDATE config SET lm_studio_url=?, api_token=?, model=?, system_prompt=?, mcp_tools=?, context_length=?, reasoning=?, stall_seconds=?, history_chars=?, parallel=?
         WHERE id=1`,
      ),
    }

    const configRow = this.stmts.selectConfig.get() as ConfigRow | undefined
    if (configRow) {
      this.config = configFromRow(configRow)
    } else {
      this.config = { ...DEFAULT_CONFIG }
      this.stmts.insertConfig.run(
        this.config.lmStudioUrl, this.config.apiToken, this.config.model, this.config.systemPrompt,
        this.config.mcpTools, this.config.contextLength, this.config.reasoning, this.config.stallSeconds,
        this.config.historyChars, this.config.parallel,
      )
    }

    const convRows = this.stmts.selectConversations.all() as unknown as ConversationRow[]
    const items: Conversation[] = convRows.map((row) => ({
      ...metaFromRow(row),
      messages: (this.stmts.selectMessagesFor.all(row.id) as unknown as MessageRow[]).map(messageFromRow),
    }))
    const activeRow = this.stmts.selectActiveId.get() as { active_id: string | null } | undefined
    this.conversations = { items, activeId: activeRow?.active_id ?? null }
    this.savedCounts = new Map(items.map((c) => [c.id, c.messages.length]))

    if (!this.conversations.items.length) {
      const first = blankConversation()
      this.conversations = { items: [first], activeId: first.id }
      this.insertConversation(first)
      this.stmts.setActiveId.run(first.id)
    }
  }

  getConversations(): ConversationStore {
    return this.conversations
  }

  get(id: string): Conversation | undefined {
    return this.conversations.items.find((c) => c.id === id)
  }

  private insertConversation(conv: Conversation): void {
    this.db.exec('BEGIN')
    try {
      this.stmts.insertConversation.run(
        conv.id, conv.name, conv.createdAt, conv.updatedAt, conv.responseId, conv.reasoning ?? null,
        conv.summary?.text ?? null, conv.summary ? String(conv.summary.through) : null,
      )
      conv.messages.forEach((m, i) => this.stmts.insertMessage.run(...messageParams(conv.id, i, m)))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.savedCounts.set(conv.id, conv.messages.length)
  }

  private writeMeta(conv: Conversation): void {
    this.stmts.updateConversationMeta.run(
      conv.name, conv.updatedAt, conv.responseId, conv.reasoning ?? null,
      conv.summary?.text ?? null, conv.summary ? String(conv.summary.through) : null,
      conv.id,
    )
  }

  /**
   * Copy a conversation's on-disk rows aside when a write would drop
   * messages. Threads are append-mostly, so a shrink is either a deliberate
   * delete or a bug -- and a bug that silently eats history is
   * unrecoverable without this.
   */
  private backupIfShrinking(id: string, incomingCount: number): void {
    const saved = this.savedCounts.get(id) ?? 0
    if (incomingCount >= saved) return
    const metaRow = this.stmts.selectConversationById.get(id) as ConversationRow | undefined
    if (!metaRow) return
    const messages = (this.stmts.selectMessagesFor.all(id) as unknown as MessageRow[]).map(messageFromRow)

    const backupDir = path.join(this.paths.dataDir, 'backups')
    fs.mkdirSync(backupDir, { recursive: true })
    const name = `conversations.${id}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    fs.writeFileSync(path.join(backupDir, name), JSON.stringify({ items: [{ ...metaFromRow(metaRow), messages }] }, null, 2))
    console.log(`[chats] message count dropped ${saved} -> ${incomingCount}; backed up to .data/backups/${name}`)
    pruneBackups(backupDir)
  }

  private writeMessages(conv: Conversation): void {
    this.backupIfShrinking(conv.id, conv.messages.length)
    this.db.exec('BEGIN')
    try {
      this.stmts.updateConversationMeta.run(
        conv.name, conv.updatedAt, conv.responseId, conv.reasoning ?? null,
        conv.summary?.text ?? null, conv.summary ? String(conv.summary.through) : null,
        conv.id,
      )
      this.stmts.deleteMessagesFor.run(conv.id)
      conv.messages.forEach((m, i) => this.stmts.insertMessage.run(...messageParams(conv.id, i, m)))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.savedCounts.set(conv.id, conv.messages.length)
  }

  create(): Conversation {
    const current = this.get(this.conversations.activeId ?? '')
    // Don't stack up empty threads, but clear any stale server-side context.
    if (current && current.messages.length === 0) {
      current.responseId = null
      current.updatedAt = stamp()
      this.writeMeta(current)
      return current
    }
    const fresh = blankConversation()
    const combined = [fresh, ...this.conversations.items]
    const kept = combined.slice(0, MAX_CONVERSATIONS)
    const dropped = combined.slice(MAX_CONVERSATIONS)
    this.conversations = { activeId: fresh.id, items: kept }
    this.insertConversation(fresh)
    this.stmts.setActiveId.run(fresh.id)
    for (const d of dropped) {
      this.stmts.deleteConversation.run(d.id)
      this.savedCounts.delete(d.id)
    }
    return fresh
  }

  setActive(id: string): void {
    if (!this.get(id)) return
    this.conversations.activeId = id
    this.stmts.setActiveId.run(id)
  }

  /**
   * `touch: false` leaves updatedAt -- and so the chat's place in the list --
   * alone: for bookkeeping the server does in the background.
   */
  patch(id: string, patch: Partial<Conversation>, { touch = true }: { touch?: boolean } = {}): Conversation | undefined {
    const conv = this.get(id)
    if (!conv) return undefined
    Object.assign(conv, patch, touch ? { updatedAt: stamp() } : {})
    this.writeMeta(conv)
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
    if (persist) this.writeMessages(conv)
  }

  remove(id: string): void {
    const items = this.conversations.items.filter((c) => c.id !== id)
    this.stmts.deleteConversation.run(id) // cascades to messages
    this.savedCounts.delete(id)
    if (!items.length) {
      const fresh = blankConversation()
      this.conversations = { items: [fresh], activeId: fresh.id }
      this.insertConversation(fresh)
    } else {
      this.conversations = {
        items,
        activeId: this.conversations.activeId === id ? items[0]!.id : this.conversations.activeId,
      }
    }
    this.stmts.setActiveId.run(this.conversations.activeId)
  }

  /**
   * Put back a conversation that was just deleted -- the Undo on the
   * "deleted" toast. If deleting it left only a fresh blank thread, that
   * placeholder goes and the restored one is opened in its place.
   */
  restore(input: Conversation): Conversation {
    if (!input || typeof input.id !== 'string' || !input.id || !Array.isArray(input.messages)) {
      throw new Error('expected a conversation with an id and messages')
    }
    const existing = this.get(input.id)
    if (existing) return existing
    const conv: Conversation = {
      ...blankConversation(),
      ...input,
      name: typeof input.name === 'string' ? input.name : '',
    }
    let items = this.conversations.items
    let activeId = this.conversations.activeId
    const placeholder = items.length === 1 && items[0]!.messages.length === 0 ? items[0]! : null
    if (placeholder) {
      items = []
      activeId = conv.id
      this.stmts.deleteConversation.run(placeholder.id)
      this.savedCounts.delete(placeholder.id)
    }
    const combined = [...items, conv]
    const kept = combined.slice(-MAX_CONVERSATIONS)
    const dropped = combined.slice(0, combined.length - kept.length)
    this.conversations = { items: kept, activeId }
    this.insertConversation(conv)
    for (const d of dropped) {
      this.stmts.deleteConversation.run(d.id)
      this.savedCounts.delete(d.id)
    }
    this.stmts.setActiveId.run(activeId)
    return conv
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
    this.stmts.updateConfig.run(
      this.config.lmStudioUrl, this.config.apiToken, this.config.model, this.config.systemPrompt,
      this.config.mcpTools, this.config.contextLength, this.config.reasoning, this.config.stallSeconds,
      this.config.historyChars, this.config.parallel,
    )
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
