import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createApi } from './api.ts'
import { ToolCatalogCache } from './tools.ts'
import type { Conversation, ConversationStore, PublicConfig } from '../src/types.ts'

let server: Server
let base: string
let dir: string
let api: ReturnType<typeof createApi>
/**
 * The engine's fetch gets stubbed per test, but these helpers talk to our own
 * HTTP server -- so hold the real implementation before any stubbing.
 */
let realFetch: typeof fetch

beforeEach(async () => {
  vi.unstubAllGlobals()
  realFetch = globalThis.fetch.bind(globalThis)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-api-'))
  api = createApi({ dir, memoryDb: path.join(dir, 'memory.sqlite') })
  server = http.createServer((req, res) => {
    api.middleware(req, res, () => { res.statusCode = 404; res.end('not api') })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  base = `http://127.0.0.1:${(addr as { port: number }).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  fs.rmSync(dir, { recursive: true, force: true })
})

const get = (p: string) => realFetch(`${base}${p}`)
const send = (p: string, method: string, body?: unknown) =>
  realFetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

describe('config', () => {
  it('never returns the token', async () => {
    api.store.setConfig({ apiToken: 'sk-lm-SECRET' })
    const body = await (await get('/api/config')).json() as PublicConfig
    expect(body.hasToken).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/SECRET/)
  })

  it('accepts a token without echoing it back', async () => {
    const res = await send('/api/config', 'PUT', { apiToken: 'sk-lm-NEW', model: 'qwen' })
    const body = await res.json() as PublicConfig
    expect(body.hasToken).toBe(true)
    expect(JSON.stringify(body)).not.toMatch(/sk-lm-NEW/)
    expect(api.store.getConfig().apiToken).toBe('sk-lm-NEW')
  })

  it('leaves the stored token alone when none is sent', async () => {
    api.store.setConfig({ apiToken: 'sk-lm-KEEP' })
    await send('/api/config', 'PUT', { model: 'other' })
    expect(api.store.getConfig().apiToken).toBe('sk-lm-KEEP')
    expect(api.store.getConfig().model).toBe('other')
  })

  it('clears the token when an empty string is sent', async () => {
    api.store.setConfig({ apiToken: 'sk-lm-GONE' })
    await send('/api/config', 'PUT', { apiToken: '' })
    expect(api.store.getConfig().apiToken).toBe('')
  })
})

describe('conversations', () => {
  it('returns the store', async () => {
    const body = await (await get('/api/chats')).json() as ConversationStore
    expect(body.items).toHaveLength(1)
  })

  it('creates, renames and deletes', async () => {
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'm', role: 'user', text: 'seed' }])

    const created = await (await send('/api/chats', 'POST')).json() as { id: string }
    expect(api.store.getConversations().items).toHaveLength(2)

    await send(`/api/chats/${created.id}`, 'PATCH', { name: 'Renamed' })
    expect(api.store.get(created.id)!.name).toBe('Renamed')

    await send(`/api/chats/${created.id}`, 'DELETE')
    expect(api.store.getConversations().items).toHaveLength(1)
  })

  it('switches the active thread, answering and announcing in a few bytes', async () => {
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'm', role: 'user', text: 'x'.repeat(100_000) }])
    const created = await (await send('/api/chats', 'POST')).json() as { id: string }
    const sent: { type: string; payload: unknown }[] = []
    const spy = vi.spyOn(api.bus, 'send').mockImplementation((e) => { sent.push(e as never) })
    const res = await send(`/api/chats/${id}/active`, 'POST')
    spy.mockRestore()
    expect(api.store.getConversations().activeId).toBe(id)
    expect(created.id).not.toBe(id)
    expect((await res.text()).length).toBeLessThan(200)
    expect(sent).toEqual([{ type: 'active', payload: { activeId: id } }])
  })

  it('announces a deletion by id, not by resending every thread', async () => {
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'm', role: 'user', text: 'seed' }])
    const created = await (await send('/api/chats', 'POST')).json() as { id: string }
    const sent: { type: string; payload: unknown }[] = []
    const spy = vi.spyOn(api.bus, 'send').mockImplementation((e) => { sent.push(e as never) })
    await send(`/api/chats/${created.id}`, 'DELETE')
    spy.mockRestore()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'removed', payload: { conversationId: created.id } })
  })

  it('404s for an unknown conversation', async () => {
    expect((await send('/api/chats/nope', 'PATCH', { name: 'x' })).status).toBe(404)
  })
})

describe('memories', () => {
  const seed = (): void => {
    const db = new DatabaseSync(path.join(dir, 'memory.sqlite'))
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?)').run('a1', 'Favorite color is green', 1, 1)
    db.close()
  }

  it('lists nothing before anything was remembered', async () => {
    expect(await (await get('/api/memories')).json()).toEqual([])
  })

  it('lists, edits and deletes', async () => {
    seed()
    expect(((await (await get('/api/memories')).json()) as { text: string }[]).map((m) => m.text)).toEqual(['Favorite color is green'])
    const edited = await send('/api/memories/a1', 'PATCH', { text: 'Favorite color is blue' })
    expect(((await edited.json()) as { text: string }).text).toBe('Favorite color is blue')
    expect((await send('/api/memories/a1', 'PATCH', { text: '  ' })).status).toBe(400)
    expect((await send('/api/memories/a1', 'DELETE')).status).toBe(200)
    expect((await send('/api/memories/a1', 'DELETE')).status).toBe(404)
  })
})

describe('a new chat in a folder', () => {
  it('is filed there from the start, and an unknown folder just means unfiled', async () => {
    const folder = await (await send('/api/folders', 'POST', { name: 'Astrology' })).json() as { id: string }
    const created = await (await send('/api/chats', 'POST', { folderId: folder.id })).json() as { id: string; folderId: string | null }
    expect(created.folderId).toBe(folder.id)
    expect(api.store.get(created.id)!.folderId).toBe(folder.id)
    api.store.setMessages(created.id, [{ id: 'm', role: 'user', text: 'seed' }]) // so the next create is a new chat
    const stray = await (await send('/api/chats', 'POST', { folderId: 'nope' })).json() as { folderId: string | null }
    expect(stray.folderId).toBeNull()
  })
})

describe('tool catalog', () => {
  it('serves what the servers reported, and re-asks them on refresh', async () => {
    const load = vi.fn(async () => ({ fetchedAt: Date.now(), servers: [
      { id: 'mcp/astrology-v2', name: 'astrology-v2', tools: [{ name: 'verify_claim', description: 'Check one claim.' }] },
    ] }))
    const own = createApi({ dir, memoryDb: path.join(dir, 'memory.sqlite'), toolCatalog: new ToolCatalogCache(load) })
    const srv = http.createServer((req, res) => own.middleware(req, res, () => { res.statusCode = 404; res.end() }))
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as { port: number }).port
    try {
      const first = await (await realFetch(`http://127.0.0.1:${port}/api/tools`)).json() as { servers: { id: string }[] }
      expect(first.servers.map((s) => s.id)).toEqual(['mcp/astrology-v2'])
      await realFetch(`http://127.0.0.1:${port}/api/tools`)
      expect(load).toHaveBeenCalledTimes(1)
      await realFetch(`http://127.0.0.1:${port}/api/tools?refresh=1`)
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })
})

describe('retitling', () => {
  it('answers at once with how many chats it will name', async () => {
    const res = await send('/api/chats/retitle', 'POST')
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ candidates: 0 })
  })
})

describe('folders', () => {
  it('creates, lists, renames and deletes', async () => {
    const created = await send('/api/folders', 'POST', { name: 'Astrology' })
    expect(created.status).toBe(201)
    const folder = await created.json() as { id: string; name: string }
    expect((await (await get('/api/folders')).json() as { name: string }[]).map((f) => f.name)).toEqual(['Astrology'])

    const renamed = await send(`/api/folders/${folder.id}`, 'PATCH', { name: 'Astro' })
    expect((await renamed.json() as { name: string }).name).toBe('Astro')

    expect((await send(`/api/folders/${folder.id}`, 'DELETE')).status).toBe(200)
    expect(await (await get('/api/folders')).json()).toEqual([])
  })

  it('reports bad input and unknown ids the same way other resources do', async () => {
    expect((await send('/api/folders', 'POST', { name: '  ' })).status).toBe(400)
    expect((await send('/api/folders/nope', 'PATCH', { name: 'x' })).status).toBe(404)
    expect((await send('/api/folders/nope', 'DELETE')).status).toBe(404)
  })

  it("sets a folder's reasoning and tool defaults, keeping what a patch leaves out", async () => {
    const folder = await (await send('/api/folders', 'POST', { name: 'Astrology' })).json() as { id: string }
    const patched = await send(`/api/folders/${folder.id}`, 'PATCH', { reasoning: 'off', mcpTools: '' })
    expect(await patched.json()).toMatchObject({ name: 'Astrology', reasoning: 'off', mcpTools: '' })
    expect(await (await get('/api/folders')).json()).toMatchObject([{ reasoning: 'off', mcpTools: '' }])
    expect((await send(`/api/folders/${folder.id}`, 'PATCH', { reasoning: 5 })).status).toBe(400)
    const withMemory = await send(`/api/folders/${folder.id}`, 'PATCH', { memory: true, memorySelection: ['m1'] })
    expect(await withMemory.json()).toMatchObject({ reasoning: 'off', mcpTools: '', memory: true, memorySelection: ['m1'] })
  })

  it('files a chat into a folder through the same PATCH the rest of a chat is edited with', async () => {
    const id = api.store.getConversations().activeId!
    const folder = await (await send('/api/folders', 'POST', { name: 'Astrology' })).json() as { id: string }
    await send(`/api/chats/${id}`, 'PATCH', { folderId: folder.id })
    expect(api.store.get(id)!.folderId).toBe(folder.id)
  })

  it('unfiles a chat when its folder is deleted, and the chat list reflects it without a reload', async () => {
    const id = api.store.getConversations().activeId!
    const folder = await (await send('/api/folders', 'POST', { name: 'Astrology' })).json() as { id: string }
    await send(`/api/chats/${id}`, 'PATCH', { folderId: folder.id })
    await send(`/api/folders/${folder.id}`, 'DELETE')
    const list = await (await get('/api/chats')).json() as ConversationStore
    expect(list.items.find((c) => c.id === id)!.folderId).toBeNull()
  })
})

describe('temporary chats', () => {
  const rawName = (id: string): string => {
    const db = new DatabaseSync(path.join(dir, 'lm-chat.sqlite'))
    try {
      return (db.prepare('SELECT name FROM conversations WHERE id = ?').get(id) as { name: string }).name
    } finally {
      db.close()
    }
  }

  it('turns on through the same PATCH the rest of a chat is edited with, and the live copy reflects it at once', async () => {
    const id = api.store.getConversations().activeId!
    const patched = await send(`/api/chats/${id}`, 'PATCH', { temporary: true })
    expect((await patched.json() as Conversation).temporary).toBe(true)
    expect(api.store.get(id)!.temporary).toBe(true)
  })

  it('keeps new messages off disk while on, and saves everything held in memory the moment it turns off', async () => {
    const id = api.store.getConversations().activeId!
    await send(`/api/chats/${id}`, 'PATCH', { temporary: true })
    api.store.setMessages(id, [{ id: 'm1', role: 'user', text: 'a throwaway question' }])
    expect(rawName(id)).toBe('') // never written -- the name would echo the question

    await send(`/api/chats/${id}`, 'PATCH', { temporary: false })
    expect(rawName(id)).toBe('a throwaway question')
  })

  it('throws away whatever was already saved for a chat the moment it turns on', async () => {
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'm1', role: 'user', text: 'a real, saved question' }])
    expect(rawName(id)).toBe('a real, saved question')

    await send(`/api/chats/${id}`, 'PATCH', { temporary: true })
    expect(rawName(id)).toBe('')
    // The live chat is untouched -- only what's on disk was thrown away.
    expect(api.store.get(id)!.messages.map((m) => m.text)).toEqual(['a real, saved question'])
  })
})

describe('loading chats on demand', () => {
  /** Two chats with history, the second one open. */
  const twoChats = async (): Promise<{ first: string; second: string }> => {
    const first = api.store.getConversations().activeId!
    api.store.setMessages(first, [{ id: 'a1', role: 'user', text: 'first chat' }, { id: 'a2', role: 'assistant', text: 'reply' }])
    const second = ((await (await send('/api/chats', 'POST')).json()) as { id: string }).id
    api.store.setMessages(second, [{ id: 'b1', role: 'user', text: 'second chat' }])
    return { first, second }
  }

  it('lists every chat, but sends messages only for the open one', async () => {
    const { first, second } = await twoChats()
    const body = await (await get('/api/chats')).json() as ConversationStore
    const open = body.items.find((c) => c.id === second)!
    const other = body.items.find((c) => c.id === first)!
    expect(open.messages.map((m) => m.text)).toEqual(['second chat'])
    expect(open.messagesOmitted).toBeUndefined()
    expect(other.messages).toEqual([])
    expect(other).toMatchObject({ messageCount: 2, messagesOmitted: true, name: 'first chat' })
  })

  it('sends the same outline to a client that connects for live updates', async () => {
    await twoChats()
    const res = await realFetch(`${base}/api/events`)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    const first = JSON.parse(new TextDecoder().decode(value).split('\n')[0]!.replace(/^data: /, '')) as { payload: ConversationStore }
    expect(first.payload.items.filter((c) => c.messagesOmitted)).toHaveLength(1)
  })

  it('sends one chat in full when asked', async () => {
    const { first } = await twoChats()
    const conv = await (await get(`/api/chats/${first}`)).json() as Conversation
    expect(conv.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
    expect(conv.messageCount).toBe(2)
    expect((await get('/api/chats/nope')).status).toBe(404)
  })

  it('compresses a large chat for a client that accepts it', async () => {
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'm', role: 'assistant', text: 'long reply '.repeat(5000) }])
    const res = await realFetch(`${base}/api/chats/${id}`, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(((await res.json()) as Conversation).messages[0]!.text).toMatch(/^long reply/)
  })

  it('restores a deleted chat in full from its own copy, even from an outline', async () => {
    const { first } = await twoChats()
    const outline = ((await (await get('/api/chats')).json()) as ConversationStore).items.find((c) => c.id === first)!
    await send(`/api/chats/${first}`, 'DELETE')
    expect((await send('/api/chats/restore', 'POST', outline)).status).toBe(200)
    expect(api.store.get(first)!.messages.map((m) => m.id)).toEqual(['a1', 'a2'])
  })

  it('refuses to restore an outline it has no copy of, rather than restore it empty', async () => {
    const res = await send('/api/chats/restore', 'POST', { id: 'gone', name: 'x', messages: [], messagesOmitted: true })
    expect(res.status).toBe(409)
    expect(api.store.get('gone')).toBeUndefined()
  })
})

describe('turns', () => {
  it('accepts a turn and returns before it finishes', async () => {
    // A turn that never settles: the response must not wait on it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* pending */ })))
    api.store.setConfig({ model: 'qwen' })
    const id = api.store.getConversations().activeId!
    const res = await send(`/api/chats/${id}/turns`, 'POST', { text: 'hello' })
    expect(res.status).toBe(202)
    // The user's message is already recorded, so a client that reloads sees it.
    expect(api.store.get(id)!.messages.at(-1)!.text).toBe('hello')
  })

  it('rejects an empty turn', async () => {
    const id = api.store.getConversations().activeId!
    expect((await send(`/api/chats/${id}/turns`, 'POST', { text: '  ' })).status).toBe(400)
  })

  it('takes images with a turn, keeps them, and serves them back by id for good', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* pending */ })))
    api.store.setConfig({ model: 'qwen' })
    const id = api.store.getConversations().activeId!
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9])
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    const res = await send(`/api/chats/${id}/turns`, 'POST', { text: '', images: [{ name: 'cat.png', mime: 'image/png', dataUrl }] })
    expect(res.status).toBe(202)
    const sent = api.store.get(id)!.messages.at(-1)!
    expect(sent.images![0]).toMatchObject({ name: 'cat.png', mime: 'image/png', bytes: 6 })
    const got = await get(`/api/images/${sent.images![0]!.id}`)
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('cache-control')).toContain('immutable')
    expect(Buffer.from(await got.arrayBuffer())).toEqual(bytes)
    expect((await get('/api/images/nope')).status).toBe(404)
  })

  it('refuses images of the wrong type, too many, or too large, before anything is kept', async () => {
    const id = api.store.getConversations().activeId!
    const png = 'data:image/png;base64,AAAA'
    const bad = async (images: unknown): Promise<string> =>
      ((await (await send(`/api/chats/${id}/turns`, 'POST', { text: 'x', images })).json()) as { error: string }).error
    expect(await bad([{ name: 'a.svg', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AAAA' }])).toMatch(/not a supported type/)
    expect(await bad(Array(7).fill({ name: 'a.png', mime: 'image/png', dataUrl: png }))).toMatch(/at most 6/)
    expect(await bad([{ name: 'big.png', mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(11 * 1024 * 1024)}` }])).toMatch(/larger than 8 MB/)
    expect(await bad('nope')).toMatch(/must be a list/)
    expect(api.store.get(id)!.messages).toHaveLength(0)
  })

  it('refuses a second turn while one is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* pending */ })))
    api.store.setConfig({ model: 'qwen' })
    const id = api.store.getConversations().activeId!
    await send(`/api/chats/${id}/turns`, 'POST', { text: 'one' })
    await vi.waitFor(() => expect(api.engine.isRunning(id)).toBe(true))
    expect((await send(`/api/chats/${id}/turns`, 'POST', { text: 'two' })).status).toBe(409)
  })

  it('retries the last message, replacing what followed it', async () => {
    api.store.setConfig({ model: 'qwen' })
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'u1', role: 'user', text: 'hello' }, { id: 'e1', role: 'error', text: 'The reply was cut short' }])
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* pending */ })))
    const res = await send(`/api/chats/${id}/retry`, 'POST')
    expect(res.status).toBe(202)
    await vi.waitFor(() => expect(api.store.get(id)!.messages.map((m) => m.id)).toEqual(['u1']))
  })

  it('has nothing to retry before a message was sent, and refuses while one is in flight', async () => {
    api.store.setConfig({ model: 'qwen' })
    const id = api.store.getConversations().activeId!
    expect((await send(`/api/chats/${id}/retry`, 'POST')).status).toBe(400)
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* pending */ })))
    await send(`/api/chats/${id}/turns`, 'POST', { text: 'one' })
    await vi.waitFor(() => expect(api.engine.isRunning(id)).toBe(true))
    expect((await send(`/api/chats/${id}/retry`, 'POST')).status).toBe(409)
  })

  it('reports whether a stop had anything to stop', async () => {
    const id = api.store.getConversations().activeId!
    const body = await (await send(`/api/chats/${id}/stop`, 'POST')).json() as { stopped: boolean }
    expect(body.stopped).toBe(false)
  })
})

describe('models', () => {
  it("proxies LM Studio's own model list using the server token: every LLM, loaded ones first", async () => {
    const f = vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ models: [
        { type: 'llm', key: 'zeta', loaded_instances: [] },
        { type: 'embedding', key: 'nomic', loaded_instances: [] },
        { type: 'llm', key: 'qwen', loaded_instances: [{ id: 'qwen:1' }] },
        { type: 'llm', key: 'alpha', loaded_instances: [] },
      ] }),
      text: () => Promise.resolve(''),
    }))
    vi.stubGlobal('fetch', f)
    api.store.setConfig({ apiToken: 'sk-lm-TOKEN' })
    const body = await (await get('/api/models')).json() as { ok: boolean; models: string[]; loaded: string[] }
    expect(body).toMatchObject({ ok: true, models: ['qwen', 'alpha', 'zeta'], loaded: ['qwen'] })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/api\/v1\/models$/)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-lm-TOKEN')
  })

  it('reports an auth failure as data, not an exception', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'Invalid token' } })),
    })))
    const body = await (await get('/api/models')).json() as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/Invalid token/)
  })
})

describe('events', () => {
  it('sends current state immediately on connect', async () => {
    const res = await realFetch(`${base}/api/events`)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    expect(text).toMatch(/"type":"conversations"/)
    await reader.cancel()
  })
})

describe('cross-origin protection', () => {
  const sendFrom = (p: string, method: string, origin: string, body?: unknown) =>
    realFetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  it('refuses a write from another site', async () => {
    const res = await sendFrom('/api/config', 'PUT', 'https://evil.example', { model: 'x' })
    expect(res.status).toBe(403)
  })

  it('allows a write from its own page', async () => {
    const host = new URL(base).host
    const res = await sendFrom('/api/config', 'PUT', `http://${host}`, { model: 'qwen' })
    expect(res.status).toBe(200)
  })

  it('allows reads from anywhere', async () => {
    const res = await sendFrom('/api/config', 'GET', 'https://evil.example')
    expect(res.status).toBe(200)
  })
})

describe('routing', () => {
  it('leaves non-api paths to the app', async () => {
    const res = await get('/index.html')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('not api')
  })

  it('404s an unknown api path', async () => {
    expect((await get('/api/nope')).status).toBe(404)
  })
})
