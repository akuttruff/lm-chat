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

  it('applies a single-conversation update without touching the others', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const other = conv({ id: 'c2', name: 'Other' })
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv(), other], 'c1') })
    })
    act(() => {
      FakeEventSource.latest().emit({
        type: 'conversation',
        payload: conv({ messages: [{ id: 'a', role: 'assistant', text: 'streaming…', streaming: true }] }),
      })
    })
    expect(result.current.active?.messages[0]!.text).toBe('streaming…')
    expect(result.current.conversations.find((c) => c.id === 'c2')).toEqual(other)
  })

  it('ignores an update for a conversation it has never been told about', async () => {
    stubApi()
    const { result } = renderHook(() => useServerState())
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => {
      FakeEventSource.latest().emit({ type: 'conversations', payload: store([conv()], 'c1') })
      FakeEventSource.latest().emit({ type: 'conversation', payload: conv({ id: 'ghost' }) })
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
