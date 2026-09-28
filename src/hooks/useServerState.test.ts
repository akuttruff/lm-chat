import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import useServerState from './useServerState.ts'
import { FakeEventSource, stubEventSource } from '../test/sse.ts'
import type { Conversation, ConversationStore } from '../types.ts'

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', name: 'Chat', createdAt: 1, updatedAt: 2,
  messages: [], responseId: null, reasoning: null, ...over,
})

const store = (items: Conversation[], activeId: string | null): ConversationStore =>
  ({ items, activeId })

function stubApi() {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
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

beforeEach(() => { stubEventSource() })

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
    })
    const urls = calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)
    expect(urls).toContain('POST /api/chats')
    expect(urls).toContain('POST /api/chats/c1/active')
    expect(urls).toContain('DELETE /api/chats/c1')
    const rename = calls.find((c) => c.init?.method === 'PATCH' && String(c.init?.body).includes('Renamed'))
    expect(JSON.parse(String(rename!.init?.body))).toEqual({ name: 'Renamed' })
    const reason = calls.find((c) => String(c.init?.body).includes('xhigh'))
    expect(JSON.parse(String(reason!.init?.body))).toEqual({ reasoning: 'xhigh' })
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
})
