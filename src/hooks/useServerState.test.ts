import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import useServerState, { finishTone } from './useServerState.ts'
import { chime } from '../lib/chime.ts'
import { FakeEventSource, stubEventSource } from '../test/sse.ts'
import type { Conversation, ConversationStore } from '../types.ts'

vi.mock('../lib/chime.ts', () => ({ chime: vi.fn(), listenForChimeUnlock: vi.fn() }))

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', name: 'Chat', createdAt: 1, updatedAt: 2,
  messages: [], responseId: null, reasoning: null, ...over,
})

const store = (items: Conversation[], activeId: string | null): ConversationStore =>
  ({ items, activeId })

/** A fake server. `routes` answers GETs of specific URLs with a body. */
function stubApi(routes: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url in routes) return Promise.resolve({ ok: true, json: () => Promise.resolve(routes[url]) })
    // The shape the real server sends; `{}` here left a resync with no chat list at all.
    if (url === '/api/chats') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], activeId: null }) })
    }
    if (url === '/api/config') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ model: 'qwen', reasoning: '', hasToken: true }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
  vi.stubGlobal('fetch', f)
  return calls
}

beforeEach(() => { stubEventSource(); vi.mocked(chime).mockClear() })

describe('useServerState', () => {
  it('subscribes to the server event stream', async () => {
    stubApi()
    renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    expect(FakeEventSource.latest().url).toBe('/api/events')
  })

  it('renders whatever conversations the server reports', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({
        type: 'conversations',
        payload: store([conv({ messages: [{ id: 'm', role: 'user', text: 'hello' }] })], 'c1'),
      })
    })
    expect(result.current.active?.messages[0]!.text).toBe('hello')
    expect(result.current.activeId).toBe('c1')
  })

  it('applies a streaming tail without resending, or touching, the rest', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const other = conv({ id: 'c2', name: 'Other' })
    const earlier = [{ id: 'u0', role: 'user' as const, text: 'earlier' }, { id: 'a0', role: 'assistant' as const, text: 'old' }]
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv({ messages: earlier }), other], 'c1') })
    })
    const { messages: _m, ...meta } = conv({ name: 'Renamed' })
    act(() => {
      FakeEventSource.latest().emit({
        type: 'tail',
        payload: {
          conversationId: 'c1', base: 2, meta,
          messages: [{ id: 'u1', role: 'user', text: 'next' }, { id: 'a1', role: 'assistant', text: 'streaming…', streaming: true }],
        },
      })
    })
    expect(result.current.active!.messages.map((m) => m.text)).toEqual(['earlier', 'old', 'next', 'streaming…'])
    expect(result.current.active!.name).toBe('Renamed')
    expect(result.current.conversations.find((c) => c.id === 'c2')).toEqual(other)
  })

  it('re-fetches everything when a tail starts past what it holds', async () => {
    const calls = stubApi()
    renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    const { messages: _m, ...meta } = conv()
    act(() => {
      FakeEventSource.latest().emit({ type: 'tail', payload: { conversationId: 'c1', base: 5, meta, messages: [] } })
    })
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chats')).toBe(true))
  })

  it('keeps a background chat\'s count current without re-fetching everything', async () => {
    const calls = stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const outline = conv({ id: 'c2', messages: [], messageCount: 4, messagesOmitted: true })
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), outline], 'c1') })
    })
    const { messages: _m, messageCount: _n, messagesOmitted: _o, ...meta } = outline
    act(() => {
      FakeEventSource.latest().emit({
        type: 'tail',
        payload: { conversationId: 'c2', base: 4, meta, messages: [{ id: 'x', role: 'assistant', text: 'streaming…' }] },
      })
    })
    expect(result.current.conversations.find((c) => c.id === 'c2')!.messageCount).toBe(5)
    expect(calls.some((c) => c.url === '/api/chats')).toBe(false)
  })

  it('loads an outlined chat\'s messages once it is the open one', async () => {
    const full = conv({ id: 'c2', messages: [{ id: 'm1', role: 'user', text: 'from the server' }], messageCount: 1 })
    const calls = stubApi({ '/api/chats/c2': full })
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({
        type: 'conversations',
        payload: store([conv(), conv({ id: 'c2', messages: [], messageCount: 1, messagesOmitted: true })], 'c2'),
      })
    })
    expect(result.current.loadingActive).toBe(true)
    await waitFor(() => expect(result.current.loadingActive).toBe(false))
    expect(result.current.active!.messages.map((m) => m.text)).toEqual(['from the server'])
    expect(calls.filter((c) => c.url === '/api/chats/c2')).toHaveLength(1)
  })

  it('keeps a rename that arrives while an outlined chat is loading', async () => {
    const full = conv({ id: 'c2', name: 'Old name', messages: [{ id: 'm1', role: 'user', text: 'from the server' }], messageCount: 1 })
    let answer: () => void = () => {}
    stubApi()
    const routed = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (url === '/api/chats/c2'
      ? new Promise((resolve) => { answer = () => resolve({ ok: true, json: () => Promise.resolve(full) }) })
      : routed(url, init))))
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const outline = conv({ id: 'c2', name: 'Old name', messages: [], messageCount: 1, messagesOmitted: true })
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), outline], 'c2') })
    })
    const { messages: _m, ...meta } = { ...outline, name: 'New name', starred: true }
    act(() => {
      FakeEventSource.latest().emit({ type: 'patch', payload: { conversationId: 'c2', meta } })
    })
    act(() => answer())
    await waitFor(() => expect(result.current.loadingActive).toBe(false))
    expect(result.current.active).toMatchObject({ name: 'New name', starred: true })
    expect(result.current.active!.messages.map((m) => m.text)).toEqual(['from the server'])
  })

  it('switches threads at once, before the server answers', async () => {
    const calls = stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), conv({ id: 'c2' })], 'c1') })
    })
    act(() => { void result.current.openChat('c2') })
    expect(result.current.activeId).toBe('c2')
    expect(calls.some((c) => c.url === '/api/chats/c2/active')).toBe(true)
  })

  it('shows a new chat from the response, without waiting for the stream', async () => {
    const created = conv({ id: 'c9', name: '', folderId: 'f1' })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = url === '/api/chats' && init?.method === 'POST' ? created : url === '/api/chats' ? store([], null) : {}
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
    }))
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    await act(async () => { await result.current.newChat('f1') })
    expect(calls).toContain('POST /api/chats')
    expect(result.current.activeId).toBe('c9')
    expect(result.current.conversations.map((c) => c.id)).toContain('c9')
    // The stream's own copy, arriving late, replaces it rather than doubling it.
    act(() => {
      FakeEventSource.latest().emit({ type: 'created', payload: { conversation: created, activeId: 'c9' } })
    })
    expect(result.current.conversations.filter((c) => c.id === 'c9')).toHaveLength(1)
  })

  it('applies metadata, creations and removals without message payloads', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const msgs = [{ id: 'u0', role: 'user' as const, text: 'kept' }]
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv({ messages: msgs })], 'c1') })
    })
    const { messages: _m, ...meta } = conv({ name: 'New name', reasoning: 'low' })
    act(() => {
      FakeEventSource.latest().emit({ type: 'patch', payload: { conversationId: 'c1', meta } })
      FakeEventSource.latest().emit({ type: 'created', payload: { conversation: conv({ id: 'c3' }), activeId: 'c3' } })
    })
    expect(result.current.conversations.find((c) => c.id === 'c1')).toMatchObject({ name: 'New name', reasoning: 'low', messages: msgs })
    expect(result.current.activeId).toBe('c3')
    act(() => {
      FakeEventSource.latest().emit({ type: 'removed', payload: { conversationId: 'c3', activeId: 'c1' } })
    })
    expect(result.current.conversations.map((c) => c.id)).toEqual(['c1'])
    expect(result.current.activeId).toBe('c1')
  })

  it('ignores an update for a conversation it has never been told about', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
      const { messages: _m, ...meta } = conv({ id: 'ghost' })
      FakeEventSource.latest().emit({ type: 'tail', payload: { conversationId: 'ghost', base: 0, meta, messages: [] } })
    })
    expect(result.current.conversations.map((c) => c.id)).toEqual(['c1'])
  })

  it('tracks status for the active thread only', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    act(() => {
      FakeEventSource.latest().emit({
        type: 'status',
        payload: { conversationId: 'c1', state: 'pending', text: 'writing...', startedAt: 123 },
      })
    })
    expect(result.current.status.text).toBe('writing...')
    expect(result.current.busy).toBe(true)

    // Chatter about a different thread must not move this one's status.
    act(() => {
      FakeEventSource.latest().emit({
        type: 'status',
        payload: { conversationId: 'other', state: '', text: 'stopped', startedAt: null },
      })
    })
    expect(result.current.status.text).toBe('writing...')
  })

  it('keeps each chat\'s status separate, so switching never locks the next one', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), conv({ id: 'c2' })], 'c1') })
      FakeEventSource.latest().emit({
        type: 'status',
        payload: { conversationId: 'c1', state: 'pending', text: 'writing...', startedAt: 123 },
      })
    })
    expect(result.current.busy).toBe(true)
    expect(Object.keys(result.current.working)).toEqual(['c1'])

    act(() => { FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), conv({ id: 'c2' })], 'c2') }) })
    expect(result.current.busy).toBe(false)
    expect(result.current.status.text).toBe('connected')

    act(() => { FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), conv({ id: 'c2' })], 'c1') }) })
    expect(result.current.status.text).toBe('writing...')
  })

  it('takes a snapshot of in-flight chats on connect, dropping ones that finished meanwhile', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
      FakeEventSource.latest().emit({
        type: 'status',
        payload: { conversationId: 'c1', state: 'pending', text: 'writing...', startedAt: 1 },
      })
      FakeEventSource.latest().emit({
        type: 'statuses',
        payload: [{ conversationId: 'c9', state: 'pending', text: 'waiting for a free slot...', startedAt: 2 }],
      })
    })
    expect(Object.keys(result.current.working)).toEqual(['c9'])
    expect(result.current.busy).toBe(false)
  })

  it('reports a dropped connection and recovers', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => { FakeEventSource.latest().onopen?.() })
    expect(result.current.connected).toBe(true)
    act(() => { FakeEventSource.latest().onerror?.() })
    expect(result.current.connected).toBe(false)
    expect(result.current.status.text).toBe('reconnecting...')
  })

  it('posts a turn rather than streaming it itself', async () => {
    const calls = stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    await act(async () => { await result.current.send('hello there') })
    const turn = calls.find((c) => c.url === '/api/chats/c1/turns')!
    expect(turn.init?.method).toBe('POST')
    expect(JSON.parse(String(turn.init?.body))).toEqual({ text: 'hello there' })
  })

  it('stops through the server', async () => {
    const calls = stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    await act(async () => { await result.current.stop() })
    expect(calls.some((c) => c.url === '/api/chats/c1/stop')).toBe(true)
  })

  it('retries the last message through the server', async () => {
    const calls = stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    await act(async () => { await result.current.retry() })
    const retry = calls.find((c) => c.url === '/api/chats/c1/retry')!
    expect(retry.init?.method).toBe('POST')
  })

  it('sends conversation actions to the server', async () => {
    const calls = stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
    })
    await act(async () => {
      await result.current.newChat()
      await result.current.openChat('c1')
      await result.current.renameChat('c1', ' Renamed ')
      await result.current.deleteChat('c1')
      await result.current.setReasoning('xhigh')
      await result.current.setStarred('c1', true)
      await result.current.setMemorySelection('c1', ['a1'])
      await result.current.setFolder('c1', 'f1')
      await result.current.setTemporary('c1', true)
    })
    const urls = calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)
    expect(urls).toContain('POST /api/chats')
    expect(urls).toContain('POST /api/chats/c1/active')
    expect(urls).toContain('DELETE /api/chats/c1')
    const rename = calls.find((c) => c.init?.method === 'PATCH' && String(c.init?.body).includes('Renamed'))
    expect(JSON.parse(String(rename!.init?.body))).toEqual({ name: 'Renamed' })
    const reason = calls.find((c) => String(c.init?.body).includes('xhigh'))
    expect(JSON.parse(String(reason!.init?.body))).toEqual({ reasoning: 'xhigh' })
    const star = calls.find((c) => c.url === '/api/chats/c1' && String(c.init?.body).includes('starred'))
    expect(JSON.parse(String(star!.init?.body))).toEqual({ starred: true })
    const selection = calls.find((c) => c.url === '/api/chats/c1' && String(c.init?.body).includes('memorySelection'))
    expect(JSON.parse(String(selection!.init?.body))).toEqual({ memorySelection: ['a1'] })
    const folder = calls.find((c) => c.url === '/api/chats/c1' && String(c.init?.body).includes('folderId'))
    expect(JSON.parse(String(folder!.init?.body))).toEqual({ folderId: 'f1' })
    const temp = calls.find((c) => c.url === '/api/chats/c1' && String(c.init?.body).includes('temporary'))
    expect(JSON.parse(String(temp!.init?.body))).toEqual({ temporary: true })
  })

  it('sorts starred chats to the top, each group newest first', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({
        type: 'conversations',
        payload: store([
          conv({ id: 'newest', updatedAt: 30 }),
          conv({ id: 'starred-old', updatedAt: 10, starred: true }),
          conv({ id: 'starred-new', updatedAt: 20, starred: true }),
        ], 'newest'),
      })
    })
    expect(result.current.conversations.map((c) => c.id)).toEqual(['starred-new', 'starred-old', 'newest'])
  })

  it('loads config without ever seeing the token', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(result.current.config?.model).toBe('qwen'))
    expect(result.current.config).not.toHaveProperty('apiToken')
    expect(result.current.config?.hasToken).toBe(true)
  })

  it('closes the stream on unmount', async () => {
    stubApi()
    const { unmount } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.latest()
    unmount()
    expect(source.closed).toBe(true)
  })

  describe('folders', () => {
    // Unlike stubApi, this tells GET and POST/PATCH/DELETE to the same URL
    // apart -- createFolder etc. read the response body, which the fire-
    // and-forget chat-patch actions above never need to.
    function stubFolders(list: { id: string; name: string; createdAt: number }[]) {
      return vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        if (url === '/api/chats') return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], activeId: null }) })
        if (url === '/api/config') return Promise.resolve({ ok: true, json: () => Promise.resolve({ model: 'qwen' }) })
        if (url === '/api/folders' && method === 'GET') return Promise.resolve({ ok: true, json: () => Promise.resolve(list) })
        if (url === '/api/folders' && method === 'POST') {
          const { name } = JSON.parse(String(init?.body)) as { name: string }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'new', name, createdAt: 9 }) })
        }
        if (url.startsWith('/api/folders/') && method === 'PATCH') {
          const { name } = JSON.parse(String(init?.body)) as { name: string }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'f1', name, createdAt: 1 }) })
        }
        if (url.startsWith('/api/folders/') && method === 'DELETE') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })
    }

    it('fetches the folder list once, on mount', async () => {
      vi.stubGlobal('fetch', stubFolders([{ id: 'f1', name: 'Astrology', createdAt: 1 }]))
      const { result } = renderHook(() => useServerState())
      await waitFor(() => expect(result.current.folders).toEqual([{ id: 'f1', name: 'Astrology', createdAt: 1 }]))
    })

    it('adds a created folder to the list, name-sorted', async () => {
      vi.stubGlobal('fetch', stubFolders([{ id: 'f1', name: 'Banter', createdAt: 1 }]))
      const { result } = renderHook(() => useServerState())
      await waitFor(() => expect(result.current.folders).toHaveLength(1))
      const created = await act(() => result.current.createFolder('Astrology'))
      expect(created).toEqual({ id: 'new', name: 'Astrology', createdAt: 9 })
      expect(result.current.folders.map((f) => f.name)).toEqual(['Astrology', 'Banter'])
    })

    it('updates a renamed folder in place', async () => {
      vi.stubGlobal('fetch', stubFolders([{ id: 'f1', name: 'Astrology', createdAt: 1 }]))
      const { result } = renderHook(() => useServerState())
      await waitFor(() => expect(result.current.folders).toHaveLength(1))
      await act(() => result.current.updateFolder('f1', { name: 'Astro' }))
      expect(result.current.folders).toEqual([{ id: 'f1', name: 'Astro', createdAt: 1 }])
    })

    it('removes a deleted folder from the list', async () => {
      vi.stubGlobal('fetch', stubFolders([{ id: 'f1', name: 'Astrology', createdAt: 1 }]))
      const { result } = renderHook(() => useServerState())
      await waitFor(() => expect(result.current.folders).toHaveLength(1))
      await act(() => result.current.deleteFolder('f1'))
      expect(result.current.folders).toEqual([])
    })
  })
})

describe('finishTone', () => {
  it('rises for a reply that arrived', () => {
    expect(finishTone(true, 'live', 'connected')).toBe('done')
  })

  it('falls for one that failed, was cut short or went quiet', () => {
    for (const text of ['failed', 'interrupted', 'no response', "can't reach LM Studio"]) {
      expect(finishTone(true, '', text)).toBe('failed')
    }
  })

  it('stays quiet for a reply you stopped, one still going, or one never seen starting', () => {
    expect(finishTone(true, '', 'stopped')).toBeNull()
    expect(finishTone(true, 'pending', 'writing...')).toBeNull()
    expect(finishTone(false, 'live', 'connected')).toBeNull()
  })
})

describe('the finished chime', () => {
  const status = (conversationId: string, state: string, text: string) =>
    ({ type: 'status', payload: { conversationId, state, text, startedAt: state === 'pending' ? 1 : null } })

  it('chimes once when a reply finishes, for any chat', async () => {
    stubApi()
    renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      const es = FakeEventSource.latest()
      es.emit({ type: 'conversations', payload: store([conv(), conv({ id: 'c2' })], 'c1') })
      es.emit(status('c2', 'pending', 'thinking...'))
      es.emit(status('c2', 'pending', 'writing...'))
    })
    expect(chime).not.toHaveBeenCalled()
    act(() => { FakeEventSource.latest().emit(status('c2', 'live', 'connected')) })
    expect(chime).toHaveBeenCalledExactlyOnceWith('done')
    act(() => { FakeEventSource.latest().emit(status('c2', 'live', 'connected')) })
    expect(chime).toHaveBeenCalledTimes(1)
  })

  it('does not chime for replies that finished while disconnected', async () => {
    stubApi()
    renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      const es = FakeEventSource.latest()
      es.emit(status('c1', 'pending', 'writing...'))
      // The reconnect snapshot no longer lists c1: it finished while we were away.
      es.emit({ type: 'statuses', payload: [] })
      es.emit(status('c1', 'live', 'connected'))
    })
    expect(chime).not.toHaveBeenCalled()
  })

  it('chimes the failed tone, and nothing for a stop', async () => {
    stubApi()
    renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      const es = FakeEventSource.latest()
      es.emit(status('c1', 'pending', 'writing...'))
      es.emit(status('c1', '', 'stopped'))
      es.emit(status('c1', 'pending', 'thinking...'))
      es.emit(status('c1', '', 'interrupted'))
    })
    expect(chime).toHaveBeenCalledExactlyOnceWith('failed')
  })
})
