import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { INTERRUPTED_TEXT, Store, deriveName } from './store.ts'
import type { Message } from '../src/types.ts'

let dir: string
let store: Store

const msg = (text: string): Message => ({ id: text, role: 'user', text })

/** A second, read-only-in-spirit connection, for asserting on rows directly. */
const openRaw = (): DatabaseSync => new DatabaseSync(path.join(dir, 'lm-chat.sqlite'))
const messageTexts = (conversationId: string): string[] => {
  const db = openRaw()
  try {
    return (db.prepare('SELECT text FROM messages WHERE conversation_id = ? ORDER BY position').all(conversationId) as { text: string | null }[])
      .map((r) => r.text ?? '')
  } finally {
    db.close()
  }
}
const rawName = (id: string): string | undefined => {
  const db = openRaw()
  try {
    return (db.prepare('SELECT name FROM conversations WHERE id = ?').get(id) as { name: string } | undefined)?.name
  } finally {
    db.close()
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-store-'))
  store = new Store({ dir })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('deriveName', () => {
  it('names a thread from its first user message', () => {
    expect(deriveName([msg('What is my forecast?')])).toBe('What is my forecast?')
  })
  it('collapses whitespace', () => {
    expect(deriveName([msg('  line\n\n  two  ')])).toBe('line two')
  })
  it('truncates a long opener', () => {
    const name = deriveName([msg('x'.repeat(100))])
    expect(name.endsWith('...')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(45)
  })
  it('returns empty with no user message', () => {
    expect(deriveName([])).toBe('')
  })
})

describe('conversations', () => {
  it('starts with one empty thread', () => {
    expect(store.getConversations().items).toHaveLength(1)
    expect(store.getConversations().activeId).toBeTruthy()
  })

  it('persists across instances', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('remember me')])
    const reopened = new Store({ dir })
    expect(reopened.get(id)!.messages[0]!.text).toBe('remember me')
  })

  it("keeps a message's images: the descriptions in the row, the bytes in a file, read back by id", () => {
    const id = store.getConversations().activeId!
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const img = store.saveImage(id, { name: 'cat.png', mime: 'image/png', bytes: png })
    expect(img).toMatchObject({ name: 'cat.png', mime: 'image/png', bytes: 7 })
    expect(fs.existsSync(path.join(dir, 'images', `${img.id}.png`))).toBe(true)
    store.setMessages(id, [{ id: 'u', role: 'user', text: 'what is this', images: [img] }])
    const reopened = new Store({ dir })
    expect(reopened.get(id)!.messages[0]!.images).toEqual([img])
    expect(reopened.readImage(img.id)).toEqual({ mime: 'image/png', bytes: png })
    expect(reopened.readImage('nope')).toBeUndefined()
    expect(reopened.readImage('../lm-chat.sqlite')).toBeUndefined() // never a path
    const db = openRaw()
    try { db.prepare("UPDATE messages SET images = '[1,2]' WHERE id = 'u'").run() } finally { db.close() }
    expect(new Store({ dir }).get(id)!.messages[0]!.images).toBeUndefined()
  })

  it("keeps a temporary chat's images in memory only, and writes them out if it stops being temporary", () => {
    const id = store.getConversations().activeId!
    store.patch(id, { temporary: true })
    const bytes = Buffer.from('jpegish')
    const img = store.saveImage(id, { name: 'a.jpg', mime: 'image/jpeg', bytes })
    store.setMessages(id, [{ id: 'u', role: 'user', text: '', images: [img] }])
    expect(fs.existsSync(path.join(dir, 'images'))).toBe(false)
    expect(store.readImage(img.id)).toEqual({ mime: 'image/jpeg', bytes }) // served while temporary
    expect(new Store({ dir }).readImage(img.id)).toBeUndefined() // but nowhere on disk
    store.patch(id, { temporary: false })
    expect(new Store({ dir }).readImage(img.id)).toEqual({ mime: 'image/jpeg', bytes })
    // And back on: the file goes, the bytes stay available to this process.
    store.patch(id, { temporary: true })
    expect(fs.existsSync(path.join(dir, 'images', `${img.id}.jpg`))).toBe(false)
    expect(store.readImage(img.id)).toEqual({ mime: 'image/jpeg', bytes })
  })

  it("keeps a reply's stats, and reads a corrupt stats value as none", () => {
    const id = store.getConversations().activeId!
    const stats = { inputTokens: 9003, outputTokens: 747, reasoningTokens: 497, tokensPerSecond: 19.6, firstTokenSeconds: 1.8 }
    store.setMessages(id, [msg('q'), { id: 'a', role: 'assistant', text: 'hi', stats }])
    expect(new Store({ dir }).get(id)!.messages[1]!.stats).toEqual(stats)
    const db = openRaw()
    try { db.prepare("UPDATE messages SET stats = 'not json' WHERE id = 'a'").run() } finally { db.close() }
    expect(new Store({ dir }).get(id)!.messages[1]!.stats).toBeUndefined()
  })

  it('creates a new thread and switches to it', () => {
    const first = store.getConversations().activeId!
    store.setMessages(first, [msg('old')])
    const fresh = store.create()
    expect(fresh.id).not.toBe(first)
    expect(store.getConversations().activeId).toBe(fresh.id)
    expect(store.getConversations().items).toHaveLength(2)
  })

  it('reuses an empty thread rather than stacking them up', () => {
    store.create()
    store.create()
    expect(store.getConversations().items).toHaveLength(1)
  })

  it('hands a reused empty thread back as a clean slate: unfiled, with no settings of its own', () => {
    const id = store.getConversations().activeId!
    const folder = store.createFolder('Astrology')
    store.patch(id, { folderId: folder.id, reasoning: 'off', memory: true, memorySelection: ['m1'], tools: 'mcp/x' })
    const reused = store.create()
    expect(reused.id).toBe(id)
    expect(reused).toMatchObject({ folderId: null, reasoning: null, memory: null, memorySelection: null, temporary: false, tools: null })
    expect(new Store({ dir }).get(id)!.folderId).toBeNull()
  })

  it("keeps a chat's own tool list, telling 'none' apart from 'inherit'", () => {
    const id = store.getConversations().activeId!
    store.patch(id, { tools: 'mcp/astrology-v2(verify_claim)' })
    expect(new Store({ dir }).get(id)!.tools).toBe('mcp/astrology-v2(verify_claim)')
    store.patch(id, { tools: '' })
    expect(new Store({ dir }).get(id)!.tools).toBe('')
    store.patch(id, { tools: 42 as unknown as string }) // junk means inherit
    expect(store.get(id)!.tools).toBeNull()
  })

  it('clears stale server context when reusing an empty thread', () => {
    const id = store.getConversations().activeId!
    store.patch(id, { responseId: 'resp_stale' })
    store.create()
    expect(store.get(id)!.responseId).toBeNull()
  })

  it('keeps messages per thread', () => {
    const first = store.getConversations().activeId!
    store.setMessages(first, [msg('one')])
    const second = store.create()
    store.setMessages(second.id, [msg('two')])
    expect(store.get(first)!.messages[0]!.text).toBe('one')
    expect(store.get(second.id)!.messages[0]!.text).toBe('two')
  })

  it('deletes a thread and moves off it', () => {
    const first = store.getConversations().activeId!
    store.setMessages(first, [msg('a')])
    const second = store.create()
    store.remove(second.id)
    expect(store.getConversations().items).toHaveLength(1)
    expect(store.getConversations().activeId).toBe(first)
  })

  it('always leaves one thread after deleting the last', () => {
    store.remove(store.getConversations().activeId!)
    expect(store.getConversations().items).toHaveLength(1)
  })

  it('orders deterministically even within one millisecond', () => {
    const first = store.getConversations().activeId!
    // Must be non-empty, or create() reuses this thread instead of adding one.
    store.setMessages(first, [msg('seed')])
    const second = store.create()
    store.setMessages(second.id, [msg('newer')])
    store.setMessages(first, [msg('bumped')])
    expect(store.get(first)!.updatedAt).toBeGreaterThan(store.get(second.id)!.updatedAt)
  })

  it('renames without touching messages', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('hello')])
    store.patch(id, { name: 'Custom' })
    expect(store.get(id)!.name).toBe('Custom')
    expect(store.get(id)!.messages).toHaveLength(1)
  })
})

describe('shrink protection', () => {
  const backups = (): string[] => {
    try { return fs.readdirSync(path.join(dir, 'backups')) } catch { return [] }
  }

  it('backs up before a write that drops messages', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, Array.from({ length: 10 }, (_, i) => msg(`m${i}`)))
    store.setMessages(id, [msg('m0')])
    expect(backups()).toHaveLength(1)
    const rescued = JSON.parse(
      fs.readFileSync(path.join(dir, 'backups', backups()[0]!), 'utf8'),
    ) as { items: { messages: Message[] }[] }
    expect(rescued.items[0]!.messages).toHaveLength(10)
  })

  it('does not back up when a thread grows', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('a')])
    store.setMessages(id, [msg('a'), msg('b')])
    expect(backups()).toHaveLength(0)
  })

  it('still writes the new state through', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('a'), msg('b')])
    store.setMessages(id, [msg('a')])
    expect(messageTexts(id)).toEqual(['a'])
  })
})

describe('config', () => {
  it('has sensible defaults', () => {
    expect(store.getConfig().lmStudioUrl).toBe('http://127.0.0.1:1234')
    expect(store.getConfig().stallSeconds).toBe('180')
    expect(store.getConfig().apiToken).toBe('')
  })

  it('persists across instances', () => {
    store.setConfig({ model: 'qwen', apiToken: 'sk-lm-SECRET' })
    expect(new Store({ dir }).getConfig().apiToken).toBe('sk-lm-SECRET')
  })

  it('never exposes the token to the browser', () => {
    store.setConfig({ apiToken: 'sk-lm-SECRET' })
    const pub = store.getPublicConfig()
    expect(pub.hasToken).toBe(true)
    expect(JSON.stringify(pub)).not.toMatch(/SECRET/)
    expect('apiToken' in pub).toBe(false)
  })

  it('reports no token when none is set', () => {
    expect(store.getPublicConfig().hasToken).toBe(false)
  })

  it('merges a partial patch', () => {
    store.setConfig({ model: 'qwen' })
    store.setConfig({ systemPrompt: 'be terse' })
    expect(store.getConfig().model).toBe('qwen')
    expect(store.getConfig().systemPrompt).toBe('be terse')
  })

  it('keeps the token out of every non-config row', () => {
    store.setConfig({ apiToken: 'sk-lm-SECRET' })
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('hi')])
    const db = openRaw()
    try {
      const nonConfig = [...db.prepare('SELECT * FROM conversations').all(), ...db.prepare('SELECT * FROM messages').all()]
      expect(JSON.stringify(nonConfig)).not.toMatch(/SECRET/)
    } finally {
      db.close()
    }
  })
})

describe('restoring a deleted chat', () => {
  it('puts it back as it was', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [{ id: 'm', role: 'user', text: 'keep me' }])
    const other = store.create()
    store.setMessages(other.id, [{ id: 'o', role: 'user', text: 'another chat' }])
    const snapshot = structuredClone(store.get(id)!)
    store.remove(id)
    expect(store.get(id)).toBeUndefined()
    store.restore(snapshot)
    expect(store.get(id)!.messages[0]!.text).toBe('keep me')
    expect(store.getConversations().items.map((c) => c.id)).toContain(other.id)
  })

  it('replaces the blank placeholder left by deleting the last chat', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [{ id: 'm', role: 'user', text: 'only chat' }])
    const snapshot = structuredClone(store.get(id)!)
    store.remove(id)
    expect(store.getConversations().items).toHaveLength(1) // the blank one
    store.restore(snapshot)
    expect(store.getConversations()).toMatchObject({ activeId: id, items: [{ id }] })
  })

  it('ignores a restore of a chat that still exists, and junk', () => {
    const id = store.getConversations().activeId!
    store.restore({ ...store.get(id)!, name: 'changed' })
    expect(store.get(id)!.name).not.toBe('changed')
    expect(() => store.restore({} as never)).toThrow(/id and messages/)
  })
})

describe('the sqlite file', () => {
  it('is private to this user', () => {
    const mode = fs.statSync(path.join(dir, 'lm-chat.sqlite')).mode
    expect(mode & 0o077).toBe(0)
  })
})

describe('migrating from conversations.json', () => {
  // A fresh dir per test here too, but no Store constructed by beforeEach --
  // migration only runs on the *first* open of a dir, so these tests need
  // to write the legacy files before that first `new Store()`.
  let freshDir: string
  beforeEach(() => {
    freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-migrate-'))
  })
  afterEach(() => fs.rmSync(freshDir, { recursive: true, force: true }))

  const legacyConversations = {
    items: [{
      id: 'old-1', name: 'Old chat', createdAt: 1, updatedAt: 2,
      messages: [{ id: 'm1', role: 'user', text: 'hello from before' }],
      responseId: null, reasoning: null, summary: null,
    }],
    activeId: 'old-1',
  }

  it('imports existing conversations and config, then renames the JSON aside', () => {
    fs.writeFileSync(path.join(freshDir, 'conversations.json'), JSON.stringify(legacyConversations))
    fs.writeFileSync(path.join(freshDir, 'config.json'), JSON.stringify({ model: 'qwen', apiToken: 'sk-lm-SECRET' }))

    const migrated = new Store({ dir: freshDir })

    expect(migrated.get('old-1')!.messages[0]!.text).toBe('hello from before')
    expect(migrated.getConversations().activeId).toBe('old-1')
    expect(migrated.getConfig().model).toBe('qwen')
    expect(fs.existsSync(path.join(freshDir, 'conversations.json'))).toBe(false)
    expect(fs.existsSync(path.join(freshDir, 'conversations.json.migrated'))).toBe(true)
    expect(fs.existsSync(path.join(freshDir, 'config.json.migrated'))).toBe(true)
  })

  it('is retried on next open if nothing was migrated yet', () => {
    // No legacy files at all: bootstraps a blank store, same as today.
    const first = new Store({ dir: freshDir })
    expect(first.getConversations().items).toHaveLength(1)
    const reopened = new Store({ dir: freshDir })
    expect(reopened.getConversations().activeId).toBe(first.getConversations().activeId)
  })
})

describe('per-chat memory setting', () => {
  it('defaults to inheriting, saves on/off, and survives a restart', () => {
    const id = store.getConversations().activeId!
    expect(store.get(id)!.memory).toBeNull()
    store.patch(id, { memory: true })
    expect(new Store({ dir }).get(id)!.memory).toBe(true)
    store.patch(id, { memory: 'yes' as never })
    expect(store.get(id)!.memory).toBeNull()
  })

  it('keeps the default in config', () => {
    expect(store.getConfig().memoryDefault).toBe('off')
    store.setConfig({ memoryDefault: 'on' })
    expect(new Store({ dir }).getConfig().memoryDefault).toBe('on')
  })

  it('adds the memory columns to a database made before they existed, keeping its chats', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, response_id TEXT, reasoning TEXT, summary_text TEXT, summary_through TEXT);
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), lm_studio_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:1234',
        api_token TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
        mcp_tools TEXT NOT NULL DEFAULT '', context_length TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
        stall_seconds TEXT NOT NULL DEFAULT '180', history_chars TEXT NOT NULL DEFAULT '24000', parallel TEXT NOT NULL DEFAULT '4');
        INSERT INTO conversations (id, name, created_at, updated_at) VALUES ('old', 'An old chat', 1, 2);
        INSERT INTO config (id, model) VALUES (1, 'qwen');`)
      db.close()
      const upgraded = new Store({ dir: oldDir })
      expect(upgraded.get('old')!.name).toBe('An old chat')
      expect(upgraded.get('old')!.memory).toBeNull()
      expect(upgraded.getConfig()).toMatchObject({ model: 'qwen', memoryDefault: 'off' })
      upgraded.patch('old', { memory: false })
      expect(new Store({ dir: oldDir }).get('old')!.memory).toBe(false)
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })
})

describe('starring a chat', () => {
  it('defaults to unstarred, saves on/off, and survives a restart', () => {
    const id = store.getConversations().activeId!
    expect(store.get(id)!.starred).toBe(false)
    store.patch(id, { starred: true })
    expect(new Store({ dir }).get(id)!.starred).toBe(true)
    store.patch(id, { starred: 'yes' as never })
    expect(store.get(id)!.starred).toBe(false)
  })

  it('adds the starred column to a database made before it existed, keeping its chats', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, response_id TEXT, reasoning TEXT, summary_text TEXT, summary_through TEXT, memory INTEGER);
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), lm_studio_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:1234',
        api_token TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
        mcp_tools TEXT NOT NULL DEFAULT '', context_length TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
        stall_seconds TEXT NOT NULL DEFAULT '180', history_chars TEXT NOT NULL DEFAULT '24000', parallel TEXT NOT NULL DEFAULT '4',
        memory_default TEXT NOT NULL DEFAULT 'off');
        INSERT INTO conversations (id, name, created_at, updated_at) VALUES ('old', 'An old chat', 1, 2);
        INSERT INTO config (id, model) VALUES (1, 'qwen');
        PRAGMA user_version = 1;`)
      db.close()
      const upgraded = new Store({ dir: oldDir })
      expect(upgraded.get('old')!.name).toBe('An old chat')
      expect(upgraded.get('old')!.starred).toBe(false)
      upgraded.patch('old', { starred: true })
      expect(new Store({ dir: oldDir }).get('old')!.starred).toBe(true)
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })
})

describe('a chat\'s hand-picked memory selection', () => {
  it('defaults to automatic (null), saves an explicit list, and survives a restart', () => {
    const id = store.getConversations().activeId!
    expect(store.get(id)!.memorySelection).toBeNull()
    store.patch(id, { memorySelection: ['a1', 'b2'] })
    expect(new Store({ dir }).get(id)!.memorySelection).toEqual(['a1', 'b2'])
    store.patch(id, { memorySelection: null })
    expect(store.get(id)!.memorySelection).toBeNull()
  })

  it('treats anything but an array of strings as "go back to automatic"', () => {
    const id = store.getConversations().activeId!
    store.patch(id, { memorySelection: 'a1' as never })
    expect(store.get(id)!.memorySelection).toBeNull()
    store.patch(id, { memorySelection: [1, 2] as never })
    expect(store.get(id)!.memorySelection).toBeNull()
  })

  it('an empty array is a real selection (none), distinct from automatic', () => {
    const id = store.getConversations().activeId!
    store.patch(id, { memorySelection: [] })
    expect(new Store({ dir }).get(id)!.memorySelection).toEqual([])
  })

  it('adds the memory_selection column to a database made before it existed, keeping its chats', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, response_id TEXT, reasoning TEXT, summary_text TEXT, summary_through TEXT, memory INTEGER,
        starred INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), lm_studio_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:1234',
        api_token TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
        mcp_tools TEXT NOT NULL DEFAULT '', context_length TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
        stall_seconds TEXT NOT NULL DEFAULT '180', history_chars TEXT NOT NULL DEFAULT '24000', parallel TEXT NOT NULL DEFAULT '4',
        memory_default TEXT NOT NULL DEFAULT 'off');
        INSERT INTO conversations (id, name, created_at, updated_at) VALUES ('old', 'An old chat', 1, 2);
        INSERT INTO config (id, model) VALUES (1, 'qwen');
        PRAGMA user_version = 2;`)
      db.close()
      const upgraded = new Store({ dir: oldDir })
      expect(upgraded.get('old')!.name).toBe('An old chat')
      expect(upgraded.get('old')!.memorySelection).toBeNull()
      upgraded.patch('old', { memorySelection: ['x'] })
      expect(new Store({ dir: oldDir }).get('old')!.memorySelection).toEqual(['x'])
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })
})

describe('folders', () => {
  it('starts with none, and a fresh chat is unfiled', () => {
    const id = store.getConversations().activeId!
    expect(store.listFolders()).toEqual([])
    expect(store.get(id)!.folderId).toBeNull()
  })

  it('creates, lists name-sorted, renames and deletes', () => {
    const b = store.createFolder('Banter')
    const a = store.createFolder('Astrology')
    expect(store.listFolders()).toEqual([a, b])
    const renamed = store.updateFolder(a.id, { name: '  Astro  ' })
    expect(renamed).toEqual({ ...a, name: 'Astro' })
    expect(store.listFolders().map((f) => f.name)).toEqual(['Astro', 'Banter'])
    expect(store.deleteFolder(a.id)).toBe(true)
    expect(store.listFolders()).toEqual([b])
  })

  it('refuses a blank or overlong name, and reports an unknown id', () => {
    expect(() => store.createFolder('   ')).toThrow(/needs a name/)
    expect(() => store.createFolder('x'.repeat(61))).toThrow(/60 characters/)
    expect(store.updateFolder('nope', { name: 'x' })).toBeUndefined()
    expect(store.deleteFolder('nope')).toBe(false)
  })

  it('keeps per-folder defaults, telling "no tools" apart from "same as Settings"', () => {
    const f = store.createFolder('Astrology')
    expect(f).toMatchObject({ reasoning: null, mcpTools: null })
    // Fields left out of a patch stay as they were.
    store.updateFolder(f.id, { reasoning: 'off' })
    expect(store.getFolder(f.id)).toMatchObject({ name: 'Astrology', reasoning: 'off', mcpTools: null })
    store.updateFolder(f.id, { mcpTools: '' })
    expect(store.getFolder(f.id)!.mcpTools).toBe('')
    store.updateFolder(f.id, { mcpTools: ' mcp/astrology-v2 ', reasoning: '' })
    // '' reasoning means inherit and is stored as such; the tool list is trimmed.
    expect(new Store({ dir }).getFolder(f.id)).toMatchObject({ reasoning: null, mcpTools: 'mcp/astrology-v2' })
    expect(() => store.updateFolder(f.id, { reasoning: 42 })).toThrow(/must be text/)
  })

  it("keeps a folder's memory switch and pick, the same shape as a chat's own", () => {
    const f = store.createFolder('Astrology')
    expect(f).toMatchObject({ memory: null, memorySelection: null })
    store.updateFolder(f.id, { memory: true, memorySelection: ['m1', 'm2'] })
    expect(new Store({ dir }).getFolder(f.id)).toMatchObject({ memory: true, memorySelection: ['m1', 'm2'] })
    // Fields left out stay; a non-boolean switch is "inherit", a non-list pick is "automatic".
    store.updateFolder(f.id, { name: 'Astro' })
    expect(store.getFolder(f.id)).toMatchObject({ memory: true, memorySelection: ['m1', 'm2'] })
    store.updateFolder(f.id, { memory: 'yes', memorySelection: 'all' })
    expect(store.getFolder(f.id)).toMatchObject({ memory: null, memorySelection: null })
    store.updateFolder(f.id, { memory: false, memorySelection: [] })
    expect(new Store({ dir }).getFolder(f.id)).toMatchObject({ memory: false, memorySelection: [] })
  })

  it('files a chat, and clears it back to unfiled on invalid input', () => {
    const id = store.getConversations().activeId!
    const f = store.createFolder('Astrology')
    store.patch(id, { folderId: f.id })
    expect(new Store({ dir }).get(id)!.folderId).toBe(f.id)
    store.patch(id, { folderId: 'not-a-real-folder' })
    expect(store.get(id)!.folderId).toBeNull()
  })

  it('unfiles a chat -- in memory too, not just on disk -- when its folder is deleted', () => {
    const id = store.getConversations().activeId!
    const f = store.createFolder('Astrology')
    store.patch(id, { folderId: f.id })
    store.deleteFolder(f.id)
    expect(store.get(id)!.folderId).toBeNull() // the live copy, no reopen
    expect(new Store({ dir }).get(id)!.folderId).toBeNull() // and what's on disk
  })

  it('adds the folders table and folder_id column to a database made before they existed, keeping its chats', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, response_id TEXT, reasoning TEXT, summary_text TEXT, summary_through TEXT, memory INTEGER,
        starred INTEGER NOT NULL DEFAULT 0, memory_selection TEXT);
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), lm_studio_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:1234',
        api_token TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
        mcp_tools TEXT NOT NULL DEFAULT '', context_length TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
        stall_seconds TEXT NOT NULL DEFAULT '180', history_chars TEXT NOT NULL DEFAULT '24000', parallel TEXT NOT NULL DEFAULT '4',
        memory_default TEXT NOT NULL DEFAULT 'off');
        INSERT INTO conversations (id, name, created_at, updated_at) VALUES ('old', 'An old chat', 1, 2);
        INSERT INTO config (id, model) VALUES (1, 'qwen');
        PRAGMA user_version = 3;`)
      db.close()
      const upgraded = new Store({ dir: oldDir })
      expect(upgraded.get('old')!.name).toBe('An old chat')
      expect(upgraded.get('old')!.folderId).toBeNull()
      expect(upgraded.listFolders()).toEqual([])
      const f = upgraded.createFolder('Astrology')
      upgraded.patch('old', { folderId: f.id })
      expect(new Store({ dir: oldDir }).get('old')!.folderId).toBe(f.id)
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })
})

describe('temporary chats', () => {
  it('defaults to false, and nothing about it reaches disk while true', () => {
    const id = store.getConversations().activeId!
    expect(store.get(id)!.temporary).toBe(false)
    store.patch(id, { temporary: true })
    expect(store.get(id)!.temporary).toBe(true) // the live copy sees it at once

    store.setMessages(id, [msg('a throwaway question')])
    store.patch(id, { name: 'Renamed while temporary' })
    expect(messageTexts(id)).toEqual([]) // never written
    expect(new Store({ dir }).get(id)!.messages).toEqual([]) // and not there on reopen either
    expect(new Store({ dir }).get(id)!.name).toBe('') // the rename never landed on disk
  })

  it('throws away whatever was already saved, including the name, the moment it turns on', () => {
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('a real question, saved normally')])
    expect(messageTexts(id)).toEqual(['a real question, saved normally'])
    expect(rawName(id)).not.toBe('')

    store.patch(id, { temporary: true })
    expect(messageTexts(id)).toEqual([]) // purged from disk right away
    expect(rawName(id)).toBe('') // scrubbed too -- it's a snippet of the question
    // The live conversation is untouched: the chat doesn't visibly change underneath you.
    expect(store.get(id)!.messages.map((m) => m.text)).toEqual(['a real question, saved normally'])
  })

  it('saves everything held in memory, in one go, the moment it turns back off', () => {
    const id = store.getConversations().activeId!
    store.patch(id, { temporary: true })
    store.setMessages(id, [msg('kept only in memory for now')])
    expect(messageTexts(id)).toEqual([])

    store.patch(id, { temporary: false })
    expect(messageTexts(id)).toEqual(['kept only in memory for now'])
    expect(new Store({ dir }).get(id)!.messages.map((m) => m.text)).toEqual(['kept only in memory for now'])
  })

  it("keeps a tool call's parameters, and adds their column to an older database", () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      const first = new Store({ dir: oldDir })
      const id = first.getConversations().activeId!
      // Back to how a version-11 database looked: no args column.
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec('ALTER TABLE messages DROP COLUMN args; PRAGMA user_version = 11;')
      db.close()
      const upgraded = new Store({ dir: oldDir })
      upgraded.setMessages(id, [{ id: 't1', role: 'tool', name: 'create_natal_chart', args: { city: 'Culver City', year: 1984 }, output: 'ok' }])
      expect(new Store({ dir: oldDir }).get(id)!.messages[0]!.args).toEqual({ city: 'Culver City', year: 1984 })
      // A transit chart's readings travel the same way; a corrupt value reads as none.
      upgraded.setMessages(id, [{ id: 't2', role: 'tool', name: 'create_transit_chart', output: '{}', readings: { 'Sun|Square|Moon': 'A day to be gentle.' } }])
      expect(new Store({ dir: oldDir }).get(id)!.messages[0]!.readings).toEqual({ 'Sun|Square|Moon': 'A day to be gentle.' })
      const raw = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      raw.exec("UPDATE messages SET readings = '[not json' WHERE id = 't2'")
      raw.close()
      expect(new Store({ dir: oldDir }).get(id)!.messages[0]!.readings).toBeUndefined()
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })

  it('adds the voice settings to a database made before them, defaulting to Heart at normal speed', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      new Store({ dir: oldDir }).setConfig({ model: 'qwen' })
      // Back to how a version-10 database looked: no voice columns.
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec('ALTER TABLE config DROP COLUMN speech_voice; ALTER TABLE config DROP COLUMN speech_speed; PRAGMA user_version = 10;')
      db.close()
      const upgraded = new Store({ dir: oldDir })
      expect(upgraded.getConfig()).toMatchObject({ model: 'qwen', speechVoice: 'af_heart', speechSpeed: '1' })
      upgraded.setConfig({ speechVoice: 'bf_emma', speechSpeed: '1.2' })
      expect(new Store({ dir: oldDir }).getConfig()).toMatchObject({ speechVoice: 'bf_emma', speechSpeed: '1.2' })
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })

  it('adds the temporary column to a database made before it existed, keeping its chats', () => {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-old-'))
    try {
      const db = new DatabaseSync(path.join(oldDir, 'lm-chat.sqlite'))
      db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, response_id TEXT, reasoning TEXT, summary_text TEXT, summary_through TEXT, memory INTEGER,
        starred INTEGER NOT NULL DEFAULT 0, memory_selection TEXT, folder_id TEXT);
        CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), lm_studio_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:1234',
        api_token TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', system_prompt TEXT NOT NULL DEFAULT '',
        mcp_tools TEXT NOT NULL DEFAULT '', context_length TEXT NOT NULL DEFAULT '', reasoning TEXT NOT NULL DEFAULT '',
        stall_seconds TEXT NOT NULL DEFAULT '180', history_chars TEXT NOT NULL DEFAULT '24000', parallel TEXT NOT NULL DEFAULT '4',
        memory_default TEXT NOT NULL DEFAULT 'off');
        INSERT INTO conversations (id, name, created_at, updated_at) VALUES ('old', 'An old chat', 1, 2);
        INSERT INTO config (id, model) VALUES (1, 'qwen');
        PRAGMA user_version = 4;`)
      db.close()
      const upgraded = new Store({ dir: oldDir })
      expect(upgraded.get('old')!.name).toBe('An old chat')
      expect(upgraded.get('old')!.temporary).toBe(false)
      upgraded.patch('old', { temporary: true })
      expect(upgraded.get('old')!.temporary).toBe(true)
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
    }
  })
})

describe('branching', () => {
  it('starts a new chat from the middle of another, carrying its settings, and leaves the original alone', () => {
    const src = store.getConversations().activeId!
    store.patch(src, { name: 'Transit questions', reasoning: 'high', memory: true, tools: 'astrology' })
    store.setMessages(src, [
      { id: 'u1', role: 'user', text: 'first question' }, { id: 'a1', role: 'assistant', text: 'first answer' },
      { id: 'u2', role: 'user', text: 'second question' }, { id: 'a2', role: 'assistant', text: 'second answer' },
    ])
    const branch = store.branch(src, 'u2')
    expect(branch.id).not.toBe(src)
    expect(branch.messages.map((m) => m.id)).toEqual(['u1', 'a1']) // up to, not including, the edited message
    expect(branch).toMatchObject({ name: 'Transit questions (branch)', reasoning: 'high', memory: true, tools: 'astrology' })
    expect(store.getConversations().activeId).toBe(branch.id)
    expect(store.get(src)!.messages).toHaveLength(4)
    expect(store.get(src)!.name).toBe('Transit questions')
    // A branch of a branch is still one "(branch)".
    expect(store.branch(branch.id, 'u1').name).toBe('Transit questions (branch)')
  })

  it('keeps a summary only when every message it covers was copied', () => {
    const src = store.getConversations().activeId!
    store.setMessages(src, [
      { id: 'u1', role: 'user', text: 'one' }, { id: 'a1', role: 'assistant', text: 'two' },
      { id: 'u2', role: 'user', text: 'three' }, { id: 'a2', role: 'assistant', text: 'four' }, { id: 'u3', role: 'user', text: 'five' },
    ])
    store.patch(src, { summary: { text: 'the gist', through: 'a2' } })
    expect(store.branch(src, 'u3').summary).toEqual({ text: 'the gist', through: 'a2' })
    expect(store.branch(src, 'u2').summary).toBeNull()
  })

  it('refuses a message that is not yours, or not there', () => {
    const src = store.getConversations().activeId!
    store.setMessages(src, [{ id: 'u1', role: 'user', text: 'q' }, { id: 'a1', role: 'assistant', text: 'a' }])
    expect(() => store.branch(src, 'a1')).toThrow(/only a message you sent/)
    expect(() => store.branch(src, 'nope')).toThrow(/no such message/)
  })
})

describe('search', () => {
  it('finds chats by name or by what was said, best first, with where it was found', () => {
    const a = store.getConversations().activeId!
    store.patch(a, { name: 'Saturn return' })
    store.setMessages(a, [{ id: 'u1', role: 'user', text: 'what does my saturn return mean?' }, { id: 'a1', role: 'assistant', text: 'A reckoning. Saturn asks for structure.' }])
    const b = store.create().id
    store.patch(b, { name: 'Dinner ideas' })
    store.setMessages(b, [{ id: 'u1', role: 'user', text: 'something with lentils' }, { id: 'a1', role: 'assistant', text: 'Lentils with saturn... no, with cumin.' }])
    const c = store.create().id
    store.setMessages(c, [{ id: 'u1', role: 'user', text: 'nothing relevant' }])
    const hits = store.search('SATURN')
    expect(hits.map((h) => h.id)).toEqual([a, b]) // the name match first; c not at all
    expect(hits[0]).toMatchObject({ inName: true, count: 2, match: { messageId: 'u1', role: 'user' } })
    expect(hits[0]!.match!.excerpt).toBe('what does my saturn return mean?')
    expect(hits[1]).toMatchObject({ inName: false, count: 1, match: { messageId: 'a1', role: 'assistant' } })
    expect(store.search('   ')).toEqual([])
  })

  it('shows enough text around a match to recognise it, from a long reply', () => {
    const a = store.getConversations().activeId!
    const long = `${'before '.repeat(40)}the needle ${'after '.repeat(40)}`
    store.setMessages(a, [{ id: 'a1', role: 'assistant', text: long }])
    const { excerpt } = store.search('needle')[0]!.match!
    expect(excerpt).toMatch(/^…before .*needle.* after…$/)
    expect(excerpt.length).toBeLessThan(150)
  })
})

describe('review fixes', () => {
  let dir: string
  let store: Store
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-store-')); store = new Store({ dir }) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('refuses a setting that is not text, and keeps memory and disk in step', () => {
    const before = store.getConfig().lmStudioUrl
    expect(() => store.setConfig({ lmStudioUrl: null as unknown as string })).toThrow('lmStudioUrl must be text')
    expect(() => store.setConfig({ bogus: 'x' } as unknown as Partial<import('../src/types.ts').ServerConfig>)).toThrow('unknown setting')
    expect(store.getConfig().lmStudioUrl).toBe(before)
    expect(new Store({ dir }).getConfig().lmStudioUrl).toBe(before)
  })

  it('leaves the store untouched when a restored copy cannot be written', () => {
    const blank = store.create()
    const bad = { ...blank, id: 'ghost', messages: [{ id: 'm', role: 'system' } as unknown as Message] }
    expect(() => store.restore(bad)).toThrow(/CHECK constraint failed: role/)
    expect(store.get('ghost')).toBeUndefined()
    expect(store.getConversations().items.map((c) => c.id)).toEqual([blank.id])
    expect(store.getConversations().activeId).toBe(blank.id)
  })

  it('keeps a restored temporary chat in memory only', () => {
    store.create()
    const temp = { ...store.create(), id: 'temp1', temporary: true, messages: [{ id: 'a', role: 'user' as const, text: 'secret' }] }
    store.restore(temp)
    expect(store.get('temp1')?.messages[0]?.text).toBe('secret')
    const db = new DatabaseSync(path.join(dir, 'lm-chat.sqlite'))
    expect(db.prepare("SELECT count(*) AS n FROM conversations WHERE id = 'temp1'").get()).toEqual({ n: 0 })
    db.close()
  })

  it('evicts the least recently updated unstarred chat past the cap, never the active or a starred one', () => {
    const ids: string[] = []
    for (let i = 0; i < 60; i++) {
      const c = store.create()
      store.setMessages(c.id, [{ id: `m${i}`, role: 'user', text: `hi ${i}` }])
      ids.push(c.id)
    }
    const oldest = ids[0]!
    store.patch(oldest, { starred: true })
    const secondOldest = ids[1]!
    const fresh = store.create()
    const kept = store.getConversations().items.map((c) => c.id)
    expect(kept).toHaveLength(60)
    expect(kept).toContain(fresh.id)
    expect(kept).toContain(oldest)
    expect(kept).not.toContain(secondOldest)
  })

  it('branching never takes over the blank chat that is open', () => {
    const source = store.create()
    store.setMessages(source.id, [{ id: 'u1', role: 'user', text: 'first' }, { id: 'a1', role: 'assistant', text: 'reply' }])
    const blank = store.create()
    const branch = store.branch(source.id, 'u1')
    expect(branch.id).not.toBe(blank.id)
    expect(store.get(blank.id)?.messages).toEqual([])
  })

  it('rewrites only the tail of a thread when told where the change starts', () => {
    const c = store.create()
    const head: Message[] = [{ id: 'u1', role: 'user', text: 'one' }, { id: 'a1', role: 'assistant', text: 'two' }]
    store.setMessages(c.id, head)
    // Tamper with the head on disk: a tail-only write must not touch it.
    const db = new DatabaseSync(path.join(dir, 'lm-chat.sqlite'))
    db.prepare("UPDATE messages SET text = 'marker' WHERE id = 'u1'").run()
    db.close()
    store.setMessages(c.id, [...head, { id: 'a2', role: 'assistant', text: 'three' }], { from: 2 })
    const reopened = new Store({ dir }).get(c.id)!
    expect(reopened.messages.map((m) => m.text)).toEqual(['marker', 'two', 'three'])
    // Without `from`, the whole thread is written again.
    store.setMessages(c.id, [...head, { id: 'a2', role: 'assistant', text: 'three' }])
    expect(new Store({ dir }).get(c.id)!.messages.map((m) => m.text)).toEqual(['one', 'two', 'three'])
  })
})

describe('settleInterrupted', () => {
  it("marks a chat whose last word was the user's as cut off, and leaves answered ones alone", () => {
    const cut = store.create()
    store.setMessages(cut.id, [{ id: 'u1', role: 'user', text: 'hello?' }])
    const answered = store.create()
    store.setMessages(answered.id, [{ id: 'u2', role: 'user', text: 'hi' }, { id: 'a2', role: 'assistant', text: 'hello' }])
    expect(store.settleInterrupted()).toBe(1)
    expect(store.get(cut.id)!.messages.at(-1)).toMatchObject({ role: 'error', text: INTERRUPTED_TEXT })
    expect(store.get(answered.id)!.messages).toHaveLength(2)
    // On disk too, and settled only once.
    expect(new Store({ dir }).get(cut.id)!.messages.at(-1)!.role).toBe('error')
    expect(store.settleInterrupted()).toBe(0)
  })
})
