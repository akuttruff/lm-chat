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
function stubApi(config: Record<string, unknown> = {}, folders: { id: string; name: string; createdAt: number }[] = []) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/config') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          lmStudioUrl: 'http://127.0.0.1:1234', model: 'qwen', systemPrompt: '',
          mcpTools: '', contextLength: '', reasoning: '', stallSeconds: '180', historyChars: '24000', parallel: '4', memoryDefault: 'off',
          hasToken: true, ...config,
        }),
      })
    }
    if (url.startsWith('/api/model-config')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ found: false, reasoning: null, thinking: null }) })
    }
    if (url === '/api/folders' && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(folders) })
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
  it('keeps the chat list beside the thread on a wide screen, collapsible and remembered', async () => {
    const user = userEvent.setup()
    const wide = (query: string) => ({ matches: query.includes('min-width'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })
    vi.stubGlobal('matchMedia', wide)
    stubApi()
    render(<App />)
    await ready()
    emit([conv({ name: 'Transit questions' })])
    expect(screen.getByRole('complementary', { name: 'Chats' })).toBeInTheDocument()
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: 'Chats' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Collapse chat list' }))
    expect(screen.queryByRole('complementary', { name: 'Chats' })).not.toBeInTheDocument()
    expect(localStorage.getItem('lm-chat.sidebar')).toBe('closed')
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Chats' }))
    expect(screen.getByRole('complementary', { name: 'Chats' })).toBeInTheDocument()
    expect(localStorage.getItem('lm-chat.sidebar')).toBe('open')
  })

  it('tucks the message bar away on a wide screen, with a corner button to bring it back', async () => {
    const user = userEvent.setup()
    const wide = (query: string) => ({ matches: query.includes('min-width'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })
    vi.stubGlobal('matchMedia', wide)
    stubApi()
    render(<App />)
    await ready()
    emit([conv({ name: 'Transit questions' })])
    await user.click(screen.getByRole('button', { name: 'Hide message bar' }))
    expect(screen.queryByPlaceholderText('Message')).not.toBeInTheDocument()
    expect(localStorage.getItem('lm-chat.composer')).toBe('closed')
    await user.click(screen.getByRole('button', { name: 'Show message bar' }))
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
    expect(localStorage.getItem('lm-chat.composer')).toBe('open')
  })

  it('never hides the message bar on a phone, even if a wide screen left it hidden', async () => {
    localStorage.setItem('lm-chat.composer', 'closed')
    stubApi()
    render(<App />)
    await ready()
    emit([conv()])
    expect(screen.getByPlaceholderText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hide message bar' })).not.toBeInTheDocument()
  })

  it('treats /compact as a command: compacts the chat and folds it, sending no message', async () => {
    const user = userEvent.setup()
    const calls = stubApi()
    const reply = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response)
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url === '/api/chats/c1/compact') return reply({ ok: true, summary: { text: 's', through: '1' }, folded: 2 })
      if (url === '/api/config') return reply({ lmStudioUrl: 'x', model: 'qwen', systemPrompt: '', mcpTools: '', contextLength: '', reasoning: '', stallSeconds: '180', historyChars: '24000', parallel: '4', memoryDefault: 'off', hasToken: true })
      if (url.startsWith('/api/model-config')) return reply({ found: false, reasoning: null, thinking: null })
      return reply(url === '/api/folders' ? [] : {})
    }))
    render(<App />)
    await ready()
    emit([conv({ messages: [{ id: '1', role: 'user', text: 'first' }, { id: '2', role: 'assistant', text: 'second' }] })])
    await screen.findByText('first')
    await user.type(screen.getByPlaceholderText('Message'), '/compact')
    await user.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chats/c1/compact')).toBe(true))
    expect(calls.some((c) => c.url === '/api/chats/c1/turns')).toBe(false)
    // The server folds the chat and says so; every device then shows it from the summary on.
    emit([conv({ folded: true, summary: { text: 's', through: '1' }, messages: [{ id: '1', role: 'user', text: 'first' }, { id: '2', role: 'assistant', text: 'second' }] })])
    await waitFor(() => expect(screen.queryByText('first')).not.toBeInTheDocument())
    expect(screen.getByText('second')).toBeInTheDocument()
  })

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

  it('deletes the open chat from the bar by the message box, with Undo putting it back', async () => {
    const user = userEvent.setup()
    const calls = stubApi()
    render(<App />)
    await ready()
    const open = conv({ id: 'c1', name: 'Transit questions', messages: [{ id: '1', role: 'user', text: 'hi' }] })
    emit([open, conv({ id: 'c2', name: 'Other' })])
    // Down in the bar by the message box, not up by New chat.
    expect(within(screen.getByRole('banner')).queryByRole('button', { name: 'Delete this chat' })).not.toBeInTheDocument()
    // On the chip row itself, not in the More menu.
    const del = screen.getByRole('button', { name: 'Delete this chat' })
    expect(del.closest('.composer-chips')).not.toBeNull()
    expect(del.closest('[role="menu"]')).toBeNull()
    await user.click(del)
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chats/c1' && c.init?.method === 'DELETE')).toBe(true))
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chats/restore')).toBe(true))
    const restored = JSON.parse(String(calls.find((c) => c.url === '/api/chats/restore')!.init!.body)) as Conversation
    expect(restored.id).toBe('c1')
  })

  it('has no delete button with no chat open', async () => {
    stubApi()
    render(<App />)
    await ready()
    emit([], null)
    expect(screen.queryByRole('button', { name: 'Delete this chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument()
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

  describe('filing a chat into a folder from the composer', () => {
    it('shows the placeholder for an unfiled chat, and the real name for a filed one', async () => {
      stubApi({}, [{ id: 'f1', name: 'Astrology', createdAt: 1 }])
      render(<App />)
      await ready()
      emit([conv({ folderId: 'f1' })])
      expect(await screen.findByRole('button', { name: 'Folder: Astrology' })).toBeInTheDocument()

      emit([conv({ folderId: null })])
      expect(await screen.findByRole('button', { name: 'Folder: Folder' })).toBeInTheDocument()
    })

    it('opens the picker for the active chat and assigns the folder tapped', async () => {
      const user = userEvent.setup()
      const calls = stubApi({}, [{ id: 'f1', name: 'Astrology', createdAt: 1 }])
      render(<App />)
      await ready()
      emit([conv({ id: 'c1' })])
      await user.click(await screen.findByRole('button', { name: 'Folder: Folder' }))
      await user.click(await screen.findByRole('button', { name: 'Astrology' }))
      const patch = calls.find((c) => c.url === '/api/chats/c1' && String(c.init?.body).includes('folderId'))
      expect(JSON.parse(String(patch!.init?.body))).toEqual({ folderId: 'f1' })
    })
  })

  describe('making a chat temporary from the composer', () => {
    it('reflects the active chat\'s state, and toggles it', async () => {
      const user = userEvent.setup()
      const calls = stubApi()
      render(<App />)
      await ready()
      emit([conv({ id: 'c1', temporary: false })])
      await user.click(await screen.findByRole('button', { name: 'More actions' }))
      await user.click(screen.getByRole('menuitemcheckbox', { name: /temporary chat/i }))
      const patch = calls.find((c) => c.url === '/api/chats/c1' && String(c.init?.body).includes('temporary'))
      expect(JSON.parse(String(patch!.init?.body))).toEqual({ temporary: true })

      emit([conv({ id: 'c1', temporary: true })])
      expect(await screen.findByRole('button', { name: /nothing is being saved/i })).toHaveAttribute('aria-pressed', 'true')
    })
  })
})
