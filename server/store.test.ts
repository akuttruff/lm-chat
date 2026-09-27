import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, deriveName } from './store.ts'
import type { Message } from '../src/types.ts'

let dir: string
let store: Store

const msg = (text: string): Message => ({ id: text, role: 'user', text })
const file = (): string => path.join(dir, 'conversations.json')

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
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).items[0].messages).toHaveLength(1)
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

  it('keeps config out of the conversations file', () => {
    store.setConfig({ apiToken: 'sk-lm-SECRET' })
    const id = store.getConversations().activeId!
    store.setMessages(id, [msg('hi')])
    expect(fs.readFileSync(file(), 'utf8')).not.toMatch(/SECRET/)
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
