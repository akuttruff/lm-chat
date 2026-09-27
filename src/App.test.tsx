import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { FakeEventSource, stubEventSource } from './test/sse.ts'
import type { Conversation, ConversationStore, Message } from './types.ts'

const conv = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'c1', name: 'Chat', createdAt: 1, updatedAt: 2,
  messages: [], responseId: null, reasoning: null, ...over,
})

const emit = (items: Conversation[], activeId: string | null = 'c1'): void => {
  act(() => {
    FakeEventSource.latest().emit({
      type: 'conversations', payload: { items, activeId } satisfies ConversationStore,
    })
  })
}

/** Records every request the passive UI makes. */
function stubApi(config: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/config') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          lmStudioUrl: 'http://127.0.0.1:1234', model: 'qwen', systemPrompt: '',
          mcpTools: '', contextLength: '', reasoning: '', stallSeconds: '180', historyChars: '24000', parallel: '4',
          hasToken: true, ...config,
        }),
      })
    }
    if (url.startsWith('/api/model-config')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ found: false, reasoning: null, thinking: null }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }))
  return calls
}

beforeEach(() => { stubEventSource() })

const ready = async (): Promise<void> => {
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
}

describe('App', () => {
  it('shows the empty state before any messages', async () => {
    stubApi()
    render(<App />)
    await ready()
    emit([conv()])
    expect(screen.getByText(/start chatting from anywhere/i)).toBeInTheDocument()
  })

  it('renders whatever the server reports, without generating anything itself', async () => {
    stubApi()
    render(<App />)
    await ready()
    const messages: Message[] = [
      { id: '1', role: 'user', text: 'my question' },
      { id: '2', role: 'reasoning', text: 'thinking', streaming: false, elapsed: '1.0' },
      { id: '3', role: 'tool', name: 'mcp/astrology', output: 'chart data', failed: false },
      { id: '4', role: 'assistant', text: 'the answer', model: 'qwen', elapsed: '2.0' },
    ]
    emit([conv({ messages })])

    expect(screen.getByText('my question')).toBeInTheDocument()
    expect(screen.getByText('the answer')).toBeInTheDocument()
    expect(screen.getByText('mcp/astrology')).toBeInTheDocument()
    expect(screen.getByText('chart data')).toBeInTheDocument()
    expect(screen.getByText(/Thought/)).toBeInTheDocument()
  })

  it('posts a turn instead of talking to LM Studio', async () => {
    const user = userEvent.setup()
    const calls = stubApi()
    render(<App />)
    await ready()
    emit([conv()])
    await user.type(screen.getByPlaceholderText('Message'), 'hello')
    await user.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/chats/c1/turns')).toBe(true)
    })
    // Nothing in the client should be reaching LM Studio directly any more.
    expect(calls.some((c) => c.url.includes('/api/v1/chat'))).toBe(false)
    expect(calls.some((c) => c.url.startsWith('/lm'))).toBe(false)
  })

  it('shows a reply that arrived while the app was away', async () => {
    // The point of the server owning turns: reconnect and it is simply there.
    stubApi()
    render(<App />)
    await ready()
    emit([conv({ messages: [{ id: '1', role: 'user', text: 'asked before reload' }] })])
    expect(screen.getByText('asked before reload')).toBeInTheDocument()
    emit([conv({
      messages: [
        { id: '1', role: 'user', text: 'asked before reload' },
        { id: '2', role: 'assistant', text: 'answered while away', model: 'qwen', elapsed: '9.0' },
      ],
    })])
    expect(screen.getByText('answered while away')).toBeInTheDocument()
  })

  it('reflects server status in the header', async () => {
    stubApi()
    render(<App />)
    await ready()
    emit([conv()])
    act(() => {
      FakeEventSource.latest().emit({
        type: 'status',
        payload: { conversationId: 'c1', state: 'pending', text: 'using mcp/astrology...', startedAt: Date.now() },
      })
    })
    expect(screen.getByText(/using mcp\/astrology/)).toBeInTheDocument()
  })

  it('offers stop while a reply is in flight', async () => {
    const user = userEvent.setup()
    const calls = stubApi()
    render(<App />)
    await ready()
    emit([conv()])
    act(() => {
      FakeEventSource.latest().emit({
        type: 'status',
        payload: { conversationId: 'c1', state: 'pending', text: 'writing...', startedAt: Date.now() },
      })
    })
    await user.click(await screen.findByRole('button', { name: /stop generating/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chats/c1/stop')).toBe(true))
  })

  it('lists conversations from the server', async () => {
    const user = userEvent.setup()
    stubApi()
    render(<App />)
    await ready()
    emit([
      conv({ id: 'c1', name: 'First chat' }),
      conv({ id: 'c2', name: 'Second chat', updatedAt: 1 }),
    ])
    await user.click(screen.getByRole('button', { name: /chats/i }))
    const drawer = await screen.findByRole('dialog')
    expect(within(drawer).getByText('First chat')).toBeInTheDocument()
    expect(within(drawer).getByText('Second chat')).toBeInTheDocument()
  })

  it('opens settings when the server has no model configured', async () => {
    stubApi({ model: '' })
    render(<App />)
    expect(await screen.findByText('Connection')).toBeInTheDocument()
  })

  it('reports a lost connection to the server', async () => {
    stubApi()
    render(<App />)
    await ready()
    emit([conv()])
    act(() => { FakeEventSource.latest().onerror?.() })
    expect(screen.getByText('reconnecting...')).toBeInTheDocument()
  })
})
