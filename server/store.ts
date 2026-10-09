import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import type {
  Conversation, ConversationStore, Folder, Message, MessageImage, MessageRole, ReplyStats, ServerConfig,
} from '../src/types.ts'
import { DEFAULT_SPEED, DEFAULT_VOICE, isVoice } from '../src/lib/speech.ts'

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
  memoryDefault: 'off',
  backgroundModel: '',
  maxOutputTokens: '',
  autoTitle: 'on',
  speechVoice: DEFAULT_VOICE,
  speechSpeed: DEFAULT_SPEED,
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
    memory: null,
    memorySelection: null,
    starred: false,
    folderId: null,
    temporary: false,
    folded: false,
    recap: null,
  }
}

function locate(dir?: string) {
  const dataDir = dir || path.resolve(process.cwd(), '.data')
  return {
    dataDir,
    sqlite: path.join(dataDir, 'lm-chat.sqlite'),
    // Image bytes, one file per image, beside the database rather than in
    // it: a photo is megabytes, and the message rows stay small and quick.
    images: path.join(dataDir, 'images'),
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
  summary_through TEXT,
  memory INTEGER,
  starred INTEGER NOT NULL DEFAULT 0,
  memory_selection TEXT,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  temporary INTEGER NOT NULL DEFAULT 0,
  folded INTEGER NOT NULL DEFAULT 0,
  recap TEXT
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reasoning TEXT,
  mcp_tools TEXT,
  memory INTEGER,
  memory_selection TEXT
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
  stats TEXT,
  images TEXT,
  args TEXT,
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
  parallel TEXT NOT NULL DEFAULT '4',
  memory_default TEXT NOT NULL DEFAULT 'off',
  background_model TEXT NOT NULL DEFAULT '',
  max_output_tokens TEXT NOT NULL DEFAULT '',
  auto_title TEXT NOT NULL DEFAULT 'on',
  speech_voice TEXT NOT NULL DEFAULT 'af_heart',
  speech_speed TEXT NOT NULL DEFAULT '1'
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
  migrateSchema(db)
}

/**
 * In-place upgrades for a database made before a column existed, gated by
 * SQLite's PRAGMA user_version. CREATE TABLE IF NOT EXISTS above covers a new
 * database; this covers an old one, since SQLite has no ADD COLUMN IF NOT
 * EXISTS. Must run before any statement naming a new column is prepared.
 */
function migrateSchema(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version < 1) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // Memory: per chat (null inherits the default), and the default itself.
    if (!has('conversations', 'memory')) db.exec('ALTER TABLE conversations ADD COLUMN memory INTEGER')
    if (!has('config', 'memory_default')) db.exec("ALTER TABLE config ADD COLUMN memory_default TEXT NOT NULL DEFAULT 'off'")
    db.exec('PRAGMA user_version = 1')
  }
  if (version < 2) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    if (!has('conversations', 'starred')) db.exec('ALTER TABLE conversations ADD COLUMN starred INTEGER NOT NULL DEFAULT 0')
    db.exec('PRAGMA user_version = 2')
  }
  if (version < 3) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    if (!has('conversations', 'memory_selection')) db.exec('ALTER TABLE conversations ADD COLUMN memory_selection TEXT')
    db.exec('PRAGMA user_version = 3')
  }
  if (version < 4) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    db.exec('CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)')
    if (!has('conversations', 'folder_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL')
    }
    db.exec('PRAGMA user_version = 4')
  }
  if (version < 5) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    if (!has('conversations', 'temporary')) db.exec('ALTER TABLE conversations ADD COLUMN temporary INTEGER NOT NULL DEFAULT 0')
    db.exec('PRAGMA user_version = 5')
  }
  if (version < 6) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // Per-folder defaults, a reply's cost, a background model and an output cap.
    if (!has('folders', 'reasoning')) db.exec('ALTER TABLE folders ADD COLUMN reasoning TEXT')
    if (!has('folders', 'mcp_tools')) db.exec('ALTER TABLE folders ADD COLUMN mcp_tools TEXT')
    if (!has('messages', 'stats')) db.exec('ALTER TABLE messages ADD COLUMN stats TEXT')
    if (!has('config', 'background_model')) db.exec("ALTER TABLE config ADD COLUMN background_model TEXT NOT NULL DEFAULT ''")
    if (!has('config', 'max_output_tokens')) db.exec("ALTER TABLE config ADD COLUMN max_output_tokens TEXT NOT NULL DEFAULT ''")
    db.exec('PRAGMA user_version = 6')
  }
  if (version < 7) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    if (!has('config', 'auto_title')) db.exec("ALTER TABLE config ADD COLUMN auto_title TEXT NOT NULL DEFAULT 'on'")
    db.exec('PRAGMA user_version = 7')
  }
  if (version < 8) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // A chat's own tool list (null inherits the folder's, then Settings').
    if (!has('conversations', 'tools')) db.exec('ALTER TABLE conversations ADD COLUMN tools TEXT')
    db.exec('PRAGMA user_version = 8')
  }
  if (version < 9) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // A folder's memory defaults, the same shape as a chat's own.
    if (!has('folders', 'memory')) db.exec('ALTER TABLE folders ADD COLUMN memory INTEGER')
    if (!has('folders', 'memory_selection')) db.exec('ALTER TABLE folders ADD COLUMN memory_selection TEXT')
    db.exec('PRAGMA user_version = 9')
  }
  if (version < 10) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // Images sent with a message (their descriptions; the bytes are files).
    if (!has('messages', 'images')) db.exec('ALTER TABLE messages ADD COLUMN images TEXT')
    db.exec('PRAGMA user_version = 10')
  }
  if (version < 11) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // The voice replies are read aloud in, and how fast.
    if (!has('config', 'speech_voice')) db.exec(`ALTER TABLE config ADD COLUMN speech_voice TEXT NOT NULL DEFAULT '${DEFAULT_VOICE}'`)
    if (!has('config', 'speech_speed')) db.exec(`ALTER TABLE config ADD COLUMN speech_speed TEXT NOT NULL DEFAULT '${DEFAULT_SPEED}'`)
    db.exec('PRAGMA user_version = 11')
  }
  if (version < 12) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // A tool call's parameters, as JSON.
    if (!has('messages', 'args')) db.exec('ALTER TABLE messages ADD COLUMN args TEXT')
    db.exec('PRAGMA user_version = 12')
  }
  if (version < 13) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // Folded by /compact: shown from the summary on, on every device.
    if (!has('conversations', 'folded')) db.exec('ALTER TABLE conversations ADD COLUMN folded INTEGER NOT NULL DEFAULT 0')
    db.exec('PRAGMA user_version = 13')
  }
  if (version < 14) {
    const has = (table: string, column: string): boolean =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
    // The reader's recap of a folded chat.
    if (!has('conversations', 'recap')) db.exec('ALTER TABLE conversations ADD COLUMN recap TEXT')
    db.exec('PRAGMA user_version = 14')
  }
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
  memory: number | null
  starred: number
  memory_selection: string | null
  folder_id: string | null
  temporary: number
  folded: number
  recap: string | null
  tools: string | null
}

interface FolderRow {
  id: string; name: string; created_at: number; reasoning: string | null; mcp_tools: string | null
  memory: number | null; memory_selection: string | null
}
const folderFromRow = (r: FolderRow): Folder => ({
  id: r.id, name: r.name, createdAt: r.created_at, reasoning: r.reasoning, mcpTools: r.mcp_tools,
  memory: r.memory == null ? null : r.memory === 1, memorySelection: parseSelection(r.memory_selection),
})

/** What a folder PATCH may change; an absent field is left as it is. */
export interface FolderPatch {
  name?: unknown
  reasoning?: unknown
  mcpTools?: unknown
  memory?: unknown
  memorySelection?: unknown
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
  stats: string | null
  images: string | null
  args: string | null
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
  memory_default: string
  background_model: string
  max_output_tokens: string
  auto_title: string
  speech_voice: string
  speech_speed: string
}

/** A row surviving corruption or a hand-edited value reads as "automatic" rather than throwing. */
function parseSelection(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? parsed : null
  } catch {
    return null
  }
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
    memory: row.memory == null ? null : row.memory === 1,
    memorySelection: parseSelection(row.memory_selection),
    starred: row.starred === 1,
    folderId: row.folder_id,
    temporary: row.temporary === 1,
    folded: row.folded === 1,
    recap: row.recap,
    tools: row.tools,
  }
}

const CONV_COLUMNS =
  'id,name,created_at,updated_at,response_id,reasoning,summary_text,summary_through,memory,starred,memory_selection,folder_id,temporary,tools,folded,recap'
const CONV_PLACEHOLDERS = CONV_COLUMNS.split(',').map(() => '?').join(',')
const UPDATE_CONV_META =
  'UPDATE conversations SET name=?, updated_at=?, response_id=?, reasoning=?, summary_text=?, summary_through=?, ' +
  'memory=?, starred=?, memory_selection=?, folder_id=?, temporary=?, tools=?, folded=?, recap=? WHERE id=?'
const memoryValue = (m: Conversation['memory']): number | null => (m == null ? null : m ? 1 : 0)
const selectionValue = (s: Conversation['memorySelection']): string | null => (s == null ? null : JSON.stringify(s))

/** In CONV_COLUMNS order. */
function convParams(c: Conversation): SQLInputValue[] {
  return [
    c.id, c.name, c.createdAt, c.updatedAt, c.responseId, c.reasoning ?? null,
    c.summary?.text ?? null, c.summary ? String(c.summary.through) : null, memoryValue(c.memory),
    c.starred ? 1 : 0, selectionValue(c.memorySelection), c.folderId ?? null, c.temporary ? 1 : 0, c.tools ?? null, c.folded ? 1 : 0, c.recap ?? null,
  ]
}

/** In UPDATE_CONV_META order. */
function convMetaParams(c: Conversation): SQLInputValue[] {
  return [
    c.name, c.updatedAt, c.responseId, c.reasoning ?? null,
    c.summary?.text ?? null, c.summary ? String(c.summary.through) : null, memoryValue(c.memory),
    c.starred ? 1 : 0, selectionValue(c.memorySelection), c.folderId ?? null, c.temporary ? 1 : 0, c.tools ?? null, c.folded ? 1 : 0, c.recap ?? null, c.id,
  ]
}

const CONFIG_COLUMNS =
  'lm_studio_url, api_token, model, system_prompt, mcp_tools, context_length, reasoning, stall_seconds, history_chars, parallel, memory_default, ' +
  'background_model, max_output_tokens, auto_title, speech_voice, speech_speed'
const CONFIG_PLACEHOLDERS = Array(16).fill('?').join(',')

/** In CONFIG_COLUMNS order. */
function configParams(c: ServerConfig): SQLInputValue[] {
  return [
    c.lmStudioUrl, c.apiToken, c.model, c.systemPrompt, c.mcpTools, c.contextLength,
    c.reasoning, c.stallSeconds, c.historyChars, c.parallel, c.memoryDefault,
    c.backgroundModel, c.maxOutputTokens, c.autoTitle, c.speechVoice, c.speechSpeed,
  ]
}

const MESSAGE_COLUMNS =
  'conversation_id,position,id,role,text,streaming,model,instance,elapsed,name,plugin,output,failed,response_id,stats,images,args'
const MESSAGE_PLACEHOLDERS = Array(17).fill('?').join(',')

/** A tool call's parameters, stored as JSON; a corrupt value, or anything but an object, reads as none. */
function parseArgs(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Image descriptions stored as JSON; a corrupt value reads as none. */
function parseImages(raw: string | null): MessageImage[] | undefined {
  if (raw == null) return undefined
  try {
    const list = JSON.parse(raw) as unknown
    if (!Array.isArray(list)) return undefined
    const images = list.filter((i): i is MessageImage =>
      typeof i === 'object' && i !== null && typeof (i as MessageImage).id === 'string' && typeof (i as MessageImage).mime === 'string')
    return images.length ? images : undefined
  } catch {
    return undefined
  }
}

/** Stats stored as JSON; a hand-edited or corrupt value reads as none. */
function parseStats(raw: string | null): ReplyStats | undefined {
  if (raw == null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && typeof (parsed as ReplyStats).tokensPerSecond === 'number'
      ? parsed as ReplyStats
      : undefined
  } catch {
    return undefined
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
  const stats = parseStats(row.stats)
  if (stats) m.stats = stats
  const images = parseImages(row.images)
  if (images) m.images = images
  const args = parseArgs(row.args)
  if (args) m.args = args
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
    m.stats ? JSON.stringify(m.stats) : null,
    m.images?.length ? JSON.stringify(m.images) : null,
    m.args ? JSON.stringify(m.args) : null,
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
    memoryDefault: row.memory_default === 'on' ? 'on' : 'off',
    backgroundModel: row.background_model ?? '',
    maxOutputTokens: row.max_output_tokens ?? '',
    autoTitle: row.auto_title === 'off' ? 'off' : 'on',
    speechVoice: isVoice(row.speech_voice) ? row.speech_voice : DEFAULT_VOICE,
    speechSpeed: row.speech_speed || DEFAULT_SPEED,
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
      `INSERT INTO conversations (${CONV_COLUMNS}) VALUES (${CONV_PLACEHOLDERS})`,
    )
    const insertMsg = db.prepare(`INSERT INTO messages (${MESSAGE_COLUMNS}) VALUES (${MESSAGE_PLACEHOLDERS})`)
    db.exec('BEGIN')
    for (const conv of conversations.items) {
      insertConv.run(
        ...convParams(conv))
      conv.messages.forEach((m, i) => insertMsg.run(...messageParams(conv.id, i, m)))
    }
    db.prepare('INSERT INTO app_state (id, active_id) VALUES (1, ?)').run(conversations.activeId)
    db.prepare(
      `INSERT INTO config (id, ${CONFIG_COLUMNS}) VALUES (1,${CONFIG_PLACEHOLDERS})`,
    ).run(...configParams(config))
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
  deleteMessagesFrom: StatementSync
  insertMessage: StatementSync
  setActiveId: StatementSync
  insertConfig: StatementSync
  updateConfig: StatementSync
  selectFolders: StatementSync
  selectFolderById: StatementSync
  insertFolder: StatementSync
  updateFolder: StatementSync
  deleteFolder: StatementSync
  scrubConversationName: StatementSync
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
  /**
   * Image bytes for temporary chats, held in memory only -- the same
   * promise their messages get. Flushed to files if the chat stops being
   * temporary, dropped with the chat otherwise.
   */
  private pendingImages = new Map<string, { conversationId: string; mime: string; bytes: Buffer }>()

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
        `INSERT INTO conversations (${CONV_COLUMNS}) VALUES (${CONV_PLACEHOLDERS})`,
      ),
      updateConversationMeta: this.db.prepare(
        UPDATE_CONV_META,
      ),
      deleteConversation: this.db.prepare('DELETE FROM conversations WHERE id = ?'),
      deleteMessagesFor: this.db.prepare('DELETE FROM messages WHERE conversation_id = ?'),
      deleteMessagesFrom: this.db.prepare('DELETE FROM messages WHERE conversation_id = ? AND position >= ?'),
      insertMessage: this.db.prepare(`INSERT INTO messages (${MESSAGE_COLUMNS}) VALUES (${MESSAGE_PLACEHOLDERS})`),
      setActiveId: this.db.prepare(
        'INSERT INTO app_state (id, active_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET active_id = excluded.active_id',
      ),
      insertConfig: this.db.prepare(
        `INSERT INTO config (id, ${CONFIG_COLUMNS}) VALUES (1,${CONFIG_PLACEHOLDERS})`,
      ),
      updateConfig: this.db.prepare(
        `UPDATE config SET lm_studio_url=?, api_token=?, model=?, system_prompt=?, mcp_tools=?, context_length=?, reasoning=?, stall_seconds=?, history_chars=?, parallel=?, memory_default=?, background_model=?, max_output_tokens=?, auto_title=?, speech_voice=?, speech_speed=? WHERE id=1`,
      ),
      selectFolders: this.db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE'),
      selectFolderById: this.db.prepare('SELECT * FROM folders WHERE id = ?'),
      insertFolder: this.db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)'),
      updateFolder: this.db.prepare('UPDATE folders SET name = ?, reasoning = ?, mcp_tools = ?, memory = ?, memory_selection = ? WHERE id = ?'),
      deleteFolder: this.db.prepare('DELETE FROM folders WHERE id = ?'),
      scrubConversationName: this.db.prepare("UPDATE conversations SET name = '' WHERE id = ?"),
    }

    const configRow = this.stmts.selectConfig.get() as ConfigRow | undefined
    if (configRow) {
      this.config = configFromRow(configRow)
    } else {
      this.config = { ...DEFAULT_CONFIG }
      this.stmts.insertConfig.run(
        ...configParams(this.config))
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
        ...convParams(conv))
      conv.messages.forEach((m, i) => this.stmts.insertMessage.run(...messageParams(conv.id, i, m)))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.savedCounts.set(conv.id, conv.messages.length)
  }

  /** A no-op while `conv.temporary`: every meta write in the class goes through here, so that's the one place the rule lives. */
  private writeMeta(conv: Conversation): void {
    if (conv.temporary) return
    this.stmts.updateConversationMeta.run(
      ...convMetaParams(conv))
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

  /** Same rule as writeMeta: a no-op while `conv.temporary`, so setMessages's own persist flag doesn't have to know about it. */
  /**
   * `from`: the first position that may have changed, when the caller knows
   * (a turn never touches what came before it). Only those rows are
   * rewritten then, instead of the whole thread on every persist of a long
   * streaming reply -- provided the rows before it are known to be on disk.
   */
  private writeMessages(conv: Conversation, from?: number): void {
    if (conv.temporary) return
    this.backupIfShrinking(conv.id, conv.messages.length)
    const saved = this.savedCounts.get(conv.id)
    const start = from != null && saved != null && from <= saved && from <= conv.messages.length ? from : 0
    this.db.exec('BEGIN')
    try {
      this.stmts.updateConversationMeta.run(
        ...convMetaParams(conv))
      if (start === 0) this.stmts.deleteMessagesFor.run(conv.id)
      else this.stmts.deleteMessagesFrom.run(conv.id, start)
      for (let i = start; i < conv.messages.length; i++) this.stmts.insertMessage.run(...messageParams(conv.id, i, conv.messages[i]!))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    this.savedCounts.set(conv.id, conv.messages.length)
  }

  create(): Conversation {
    const current = this.get(this.conversations.activeId ?? '')
    // Don't stack up empty threads -- but "new chat" must still mean a clean
    // slate: an empty chat that was filed into a folder or given its own
    // settings would otherwise come back exactly as it was, and pressing +
    // would seem to do nothing at all.
    if (current && current.messages.length === 0) {
      const blank = blankConversation()
      Object.assign(current, {
        responseId: null, updatedAt: stamp(), reasoning: blank.reasoning, memory: blank.memory,
        memorySelection: blank.memorySelection, folderId: blank.folderId, temporary: blank.temporary, tools: null,
      })
      this.writeMeta(current)
      return current
    }
    return this.newConversation()
  }

  /** A fresh chat, inserted and made active -- never a reused blank one. */
  private newConversation(): Conversation {
    const fresh = blankConversation()
    this.insertConversation(fresh)
    this.conversations = { activeId: fresh.id, items: this.capped([fresh, ...this.conversations.items], fresh.id) }
    this.stmts.setActiveId.run(fresh.id)
    return fresh
  }

  /**
   * At most MAX_CONVERSATIONS: beyond that the least recently updated chats
   * go first, never a starred one and never `keep` (the one just made or
   * brought back). Dropped chats are removed from disk here too.
   */
  private capped(items: Conversation[], keep: string): Conversation[] {
    if (items.length <= MAX_CONVERSATIONS) return items
    const candidates = items
      .filter((c) => c.id !== keep && !c.starred)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const drop = new Set(candidates.slice(0, items.length - MAX_CONVERSATIONS).map((c) => c.id))
    for (const id of drop) {
      this.stmts.deleteConversation.run(id)
      this.savedCounts.delete(id)
    }
    return items.filter((c) => !drop.has(c.id))
  }

  /**
   * A new chat that picks up from the middle of another: everything before
   * `messageId` copied over, with the chat's settings (folder, reasoning,
   * memory, tools), ready for a changed message to be sent in place of the
   * original one. The source is left exactly as it was -- that's the point:
   * both versions of the conversation stay. Named after the source, so the
   * two sit together in the list; the copied images are shared, not
   * duplicated (image files are never deleted with a chat).
   */
  branch(sourceId: string, messageId: string): Conversation {
    const source = this.get(sourceId)
    if (!source) throw new Error('no such conversation')
    const at = source.messages.findIndex((m) => String(m.id) === messageId)
    if (at === -1) throw new Error('no such message')
    if (source.messages[at]!.role !== 'user') throw new Error('only a message you sent can be edited')
    // Always a new chat: create() would otherwise take over whatever blank
    // chat happens to be open, maybe on another device.
    const conv = this.newConversation()
    const name = source.name ? `${source.name.replace(/ \(branch\)$/, '')} (branch)` : ''
    this.patch(conv.id, {
      name, folderId: source.folderId ?? null, reasoning: source.reasoning ?? null,
      memory: source.memory ?? null, memorySelection: source.memorySelection ?? null,
      tools: source.tools ?? null, temporary: source.temporary === true,
    }, { touch: false })
    const kept = source.messages.slice(0, at).map((m) => ({ ...m }))
    // A summary that only covers copied messages still stands; one reaching past the cut doesn't.
    const summary = source.summary && kept.some((m) => m.id === source.summary!.through) ? source.summary : null
    this.patch(conv.id, { summary }, { touch: false })
    this.setMessages(conv.id, kept, { touch: true })
    return this.get(conv.id)!
  }

  /**
   * Chats whose name or messages contain `query`, case-insensitively: best
   * first (a name match, then the most hits), each with where it was first
   * found, for the drawer's search. Over what's in memory, so temporary
   * chats are searched too.
   */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: SearchHit[] = []
    for (const c of this.conversations.items) {
      const inName = c.name.toLowerCase().includes(q)
      let count = 0
      let first: SearchHit['match'] | null = null
      for (const m of c.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        const text = m.text || ''
        const i = text.toLowerCase().indexOf(q)
        if (i === -1) continue
        count++
        if (!first) first = { messageId: String(m.id), role: m.role, excerpt: excerptAround(text, i, q.length) }
      }
      if (!inName && !count) continue
      hits.push({
        id: c.id, name: c.name, updatedAt: c.updatedAt, folderId: c.folderId ?? null, inName, count,
        match: first,
      })
    }
    hits.sort((a, b) => Number(b.inName) - Number(a.inName) || b.count - a.count || b.updatedAt - a.updatedAt)
    return hits.slice(0, limit)
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
  /**
   * Change a chat's settings or name. `touch` is off by default: starring,
   * renaming or filing a chat is not a conversation, so it must not move the
   * chat up the list or change the time shown next to it. Only a message
   * sent does that (see setMessages).
   */
  patch(id: string, patch: Partial<Conversation>, { touch = false }: { touch?: boolean } = {}): Conversation | undefined {
    const conv = this.get(id)
    if (!conv) return undefined
    // Anything but a real on/off means "use the default".
    if ('memory' in patch) patch = { ...patch, memory: typeof patch.memory === 'boolean' ? patch.memory : null }
    if ('starred' in patch) patch = { ...patch, starred: patch.starred === true }
    // Anything but a real array of ids means "go back to automatic".
    if ('memorySelection' in patch) {
      patch = { ...patch, memorySelection: cleanSelection(patch.memorySelection) }
    }
    // A folder that doesn't exist (deleted from under it, or just bad input) means "no folder", not an error.
    if ('folderId' in patch) {
      const f = patch.folderId
      patch = { ...patch, folderId: typeof f === 'string' && this.stmts.selectFolderById.get(f) ? f : null }
    }
    if ('temporary' in patch) patch = { ...patch, temporary: patch.temporary === true }
    if ('folded' in patch) patch = { ...patch, folded: patch.folded === true }
    // Anything but text means "same as the folder / Settings"; '' is a real choice of no tools.
    if ('tools' in patch) patch = { ...patch, tools: typeof patch.tools === 'string' ? patch.tools : null }

    const wasTemporary = conv.temporary === true
    Object.assign(conv, patch, touch ? { updatedAt: stamp() } : {})

    if (conv.temporary && !wasTemporary) {
      // Just turned on: this chat's own promise is that nothing about it is
      // kept, so whatever was already saved for it goes now, not just what
      // comes next. The name goes too -- it's usually a snippet of the
      // first message, so it can say as much as the messages themselves.
      // Its images come off disk into memory for the same reason.
      this.stmts.deleteMessagesFor.run(id)
      this.stmts.scrubConversationName.run(id)
      this.savedCounts.set(id, 0)
      for (const img of imagesOf(conv)) {
        const file = this.imageFile(img.id)
        if (!file) continue
        this.pendingImages.set(img.id, { conversationId: id, mime: img.mime, bytes: fs.readFileSync(file) })
        fs.rmSync(file, { force: true })
      }
    } else if (!conv.temporary && wasTemporary) {
      // Just turned off: everything held in memory while it was temporary
      // gets saved now, in one go, catching disk up to the live state.
      this.writeMessages(conv)
      for (const img of imagesOf(conv)) {
        const pending = this.pendingImages.get(img.id)
        if (!pending) continue
        this.writeImageFile(img.id, pending.mime, pending.bytes)
        this.pendingImages.delete(img.id)
      }
    } else {
      this.writeMeta(conv) // no-op on its own if conv.temporary is (still) true
    }
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
    { persist = true, touch = true, from }: { persist?: boolean; touch?: boolean; from?: number } = {},
  ): void {
    const conv = this.get(id)
    if (!conv) return
    conv.messages = messages
    if (!conv.name) conv.name = deriveName(messages)
    if (touch) conv.updatedAt = stamp()
    if (persist) this.writeMessages(conv, from)
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
    // On disk first: if the copy is unusable the store is left as it was.
    // A temporary chat is not written, the same as everywhere else.
    if (!conv.temporary) this.insertConversation(conv)
    let items = this.conversations.items
    let activeId = this.conversations.activeId
    const placeholder = items.length === 1 && items[0]!.messages.length === 0 ? items[0]! : null
    if (placeholder) {
      items = []
      activeId = conv.id
      this.stmts.deleteConversation.run(placeholder.id)
      this.savedCounts.delete(placeholder.id)
    }
    this.conversations = { items: this.capped([...items, conv], conv.id), activeId }
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
    // Every setting is text; anything else would be written as NULL, or
    // crash the code that reads it later. The in-memory copy changes only
    // once the row has, so a rejected write leaves both as they were.
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in this.config)) throw new Error(`unknown setting: ${key}`)
      if (typeof value !== 'string') throw new Error(`${key} must be text`)
    }
    const next = { ...this.config, ...patch }
    this.stmts.updateConfig.run(
      ...configParams(next))
    this.config = next
    return next
  }

  // --- images --------------------------------------------------------------

  /**
   * Keep an image sent with a message and return its description for the
   * message. Bytes go to a file (`.data/images/<id>.<ext>`), unless the chat
   * is temporary, in which case they stay in memory like its messages.
   */
  saveImage(conversationId: string, image: { name: string; mime: string; bytes: Buffer }): MessageImage {
    const id = newId()
    const desc: MessageImage = { id, name: image.name, mime: image.mime, bytes: image.bytes.length }
    if (this.get(conversationId)?.temporary) {
      this.pendingImages.set(id, { conversationId, mime: image.mime, bytes: image.bytes })
    } else {
      this.writeImageFile(id, image.mime, image.bytes)
    }
    return desc
  }

  /** The bytes of a saved image, wherever they are; undefined when unknown. */
  readImage(id: string): { mime: string; bytes: Buffer } | undefined {
    const pending = this.pendingImages.get(id)
    if (pending) return { mime: pending.mime, bytes: pending.bytes }
    const file = this.imageFile(id)
    if (!file) return undefined
    return { mime: mimeOfExt(path.extname(file)), bytes: fs.readFileSync(file) }
  }

  private writeImageFile(id: string, mime: string, bytes: Buffer): void {
    fs.mkdirSync(this.paths.images, { recursive: true })
    fs.writeFileSync(path.join(this.paths.images, `${id}${extOfMime(mime)}`), bytes, { mode: 0o600 })
  }

  /** The file holding an image's bytes, found by id whatever its type turned out to be. */
  private imageFile(id: string): string | undefined {
    // Ids are the store's own (see newId), so this can't walk outside the images dir.
    if (!/^[a-z0-9-]+$/.test(id)) return undefined
    for (const ext of Object.keys(MIME_BY_EXT)) {
      const file = path.join(this.paths.images, `${id}${ext}`)
      if (fs.existsSync(file)) return file
    }
    return undefined
  }

  // --- folders -------------------------------------------------------------

  listFolders(): Folder[] {
    return (this.stmts.selectFolders.all() as unknown as FolderRow[]).map(folderFromRow)
  }

  createFolder(name: unknown): Folder {
    // Explicit nulls, the same shape a row reads back as: a new folder inherits everything.
    const folder: Folder = {
      id: newId(), name: cleanFolderName(name), createdAt: stamp(), reasoning: null, mcpTools: null, memory: null, memorySelection: null,
    }
    this.stmts.insertFolder.run(folder.id, folder.name, folder.createdAt)
    return folder
  }

  getFolder(id: string): Folder | undefined {
    const row = this.stmts.selectFolderById.get(id) as FolderRow | undefined
    return row ? folderFromRow(row) : undefined
  }

  /** Change a folder's name or defaults; fields left out of the patch stay as they were. */
  updateFolder(id: string, patch: FolderPatch): Folder | undefined {
    const current = this.getFolder(id)
    if (!current) return undefined
    const next: Folder = {
      ...current,
      name: patch.name === undefined ? current.name : cleanFolderName(patch.name),
      reasoning: patch.reasoning === undefined ? current.reasoning : cleanFolderDefault(patch.reasoning, 'reasoning', 40),
      mcpTools: patch.mcpTools === undefined ? current.mcpTools : cleanFolderDefault(patch.mcpTools, 'tools', 500),
      // Same rules as a chat's own: anything but a boolean is "inherit", anything but a list of ids is "automatic".
      memory: patch.memory === undefined ? current.memory : typeof patch.memory === 'boolean' ? patch.memory : null,
      memorySelection: patch.memorySelection === undefined ? current.memorySelection : cleanSelection(patch.memorySelection),
    }
    this.stmts.updateFolder.run(
      next.name, next.reasoning ?? null, next.mcpTools ?? null, memoryValue(next.memory), selectionValue(next.memorySelection), id,
    )
    return next
  }

  /**
   * The foreign key's ON DELETE SET NULL clears `folder_id` on disk for any
   * chat that was in it; the in-memory copies need the same update by hand,
   * since they were loaded before this delete and won't see it otherwise.
   */
  deleteFolder(id: string): boolean {
    const removed = this.stmts.deleteFolder.run(id).changes > 0
    if (removed) for (const c of this.conversations.items) if (c.folderId === id) c.folderId = null
    return removed
  }
}

/** The image types the model is sent, by file extension; anything else is refused at the API. */
export const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}
const extOfMime = (mime: string): string => Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] ?? '.bin'
const mimeOfExt = (ext: string): string => MIME_BY_EXT[ext] ?? 'application/octet-stream'
const imagesOf = (conv: Conversation): MessageImage[] => conv.messages.flatMap((m) => m.images ?? [])

/** A memory selection from a client: a list of ids, or null for automatic. */
const cleanSelection = (s: unknown): string[] | null =>
  (Array.isArray(s) && s.every((x) => typeof x === 'string') ? s as string[] : null)

function cleanFolderName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n) throw new Error('A folder needs a name.')
  if (n.length > 60) throw new Error(`A folder name can be at most 60 characters; this one is ${n.length}.`)
  return n
}

/**
 * A folder default: null means inherit. Reasoning's '' also means inherit,
 * so it's stored as null; tools' '' is kept, since it means "none".
 */
function cleanFolderDefault(value: unknown, what: 'reasoning' | 'tools', max: number): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new Error(`A folder's ${what} default must be text.`)
  const v = value.trim()
  if (v.length > max) throw new Error(`A folder's ${what} default can be at most ${max} characters.`)
  if (what === 'reasoning' && !v) return null
  return v
}

/** Name a thread from its opening message, the way LM Studio titles a chat. */
/** One chat the search found, and where in it. */
export interface SearchHit {
  id: string
  name: string
  updatedAt: number
  folderId: string | null
  /** The chat's name contains the query. */
  inName: boolean
  /** Messages containing it. */
  count: number
  /** The first of those: enough text around the match to recognise it. */
  match: { messageId: string; role: 'user' | 'assistant'; excerpt: string } | null
}

/** About 140 characters around a match, on one line, with ellipses where it was cut. */
export function excerptAround(text: string, at: number, length: number, width = 140): string {
  const flat = text.replace(/\s+/g, ' ')
  // The match moved with the whitespace collapse: find it again from the same proportional spot.
  const i = flat.toLowerCase().indexOf(text.slice(at, at + length).toLowerCase().replace(/\s+/g, ' '))
  const start = Math.max(0, (i === -1 ? 0 : i) - Math.floor((width - length) / 2))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}

export function deriveName(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return ''
  const t = (first.text || '').replace(/\s+/g, ' ').trim()
  return t.length > 42 ? `${t.slice(0, 42).trimEnd()}...` : t
}
