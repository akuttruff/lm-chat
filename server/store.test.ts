import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store, deriveName } from './store.ts'
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
