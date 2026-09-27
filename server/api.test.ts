import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import type { Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi } from './api.ts'
import type { ConversationStore, PublicConfig } from '../src/types.ts'

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
  api = createApi({ dir })
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

  it('switches the active thread', async () => {
    const id = api.store.getConversations().activeId!
    api.store.setMessages(id, [{ id: 'm', role: 'user', text: 'seed' }])
    const created = await (await send('/api/chats', 'POST')).json() as { id: string }
    await send(`/api/chats/${id}/active`, 'POST')
    expect(api.store.getConversations().activeId).toBe(id)
    expect(created.id).not.toBe(id)
  })

  it('404s for an unknown conversation', async () => {
    expect((await send('/api/chats/nope', 'PATCH', { name: 'x' })).status).toBe(404)
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

  it('refuses a second turn while one is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* pending */ })))
    api.store.setConfig({ model: 'qwen' })
    const id = api.store.getConversations().activeId!
    await send(`/api/chats/${id}/turns`, 'POST', { text: 'one' })
    await vi.waitFor(() => expect(api.engine.isRunning(id)).toBe(true))
    expect((await send(`/api/chats/${id}/turns`, 'POST', { text: 'two' })).status).toBe(409)
  })

  it('reports whether a stop had anything to stop', async () => {
    const id = api.store.getConversations().activeId!
    const body = await (await send(`/api/chats/${id}/stop`, 'POST')).json() as { stopped: boolean }
    expect(body.stopped).toBe(false)
  })
})

describe('models', () => {
  it('proxies the model list using the server token', async () => {
    const f = vi.fn(() => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ data: [{ id: 'qwen' }] }),
      text: () => Promise.resolve(''),
    }))
    vi.stubGlobal('fetch', f)
    api.store.setConfig({ apiToken: 'sk-lm-TOKEN' })
    const body = await (await get('/api/models')).json() as { ok: boolean; models: string[] }
    expect(body).toMatchObject({ ok: true, models: ['qwen'] })
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
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
