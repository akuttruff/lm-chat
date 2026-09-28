import { useState, useEffect, useCallback, useRef } from 'react'
import type { Conversation, ConversationMeta, ConversationStore, Message, PublicConfig, Status } from '../types.ts'

/**
 * The whole client state, streamed from the app server.
 *
 * The UI is passive: it posts intent and renders what the server reports.
 * Because the server owns each turn, a locked screen, a backgrounded tab or a
 * full reload no longer interrupts anything -- reconnecting just resumes the
 * live picture.
 */
export interface ServerState {
  conversations: Conversation[]
  activeId: string | null
  active: Conversation | null
  config: PublicConfig | null
  /** The active chat's status (or the connection's, when it has none). */
  status: Status
  startedAt: number | null
  connected: boolean
  /** Whether the active chat has a reply in flight. Other chats stay usable. */
  busy: boolean
  /** Every chat with a reply in flight, keyed by id, e.g. for the chat list. */
  working: Record<string, ChatStatus>
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  /** Re-run the last message you sent, replacing the reply that followed it. */
  retry: () => Promise<void>
  newChat: () => Promise<void>
  openChat: (id: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  /** Put back a conversation just deleted, from the copy the client still holds. */
  restoreChat: (conversation: Conversation) => Promise<void>
  renameChat: (id: string, name: string) => Promise<void>
  setReasoning: (value: string | null) => Promise<void>
  saveConfig: (patch: Partial<PublicConfig> & { apiToken?: string }) => Promise<void>
  refreshConfig: () => Promise<void>
}

/** One chat's progress, as the server reports it. */
export interface ChatStatus {
  state: Status['state']
  text: string
  startedAt: number | null
}

type StatusEvent = { conversationId: string; state: string; text: string; startedAt: number | null }

type ServerEvent =
  | { type: 'conversations'; payload: ConversationStore }
  | { type: 'active'; payload: { activeId: string | null } }
  | { type: 'tail'; payload: { conversationId: string; base: number; messages: Message[]; meta: ConversationMeta } }
  | { type: 'patch'; payload: { conversationId: string; meta: ConversationMeta } }
  | { type: 'created'; payload: { conversation: Conversation; activeId: string | null } }
  | { type: 'removed'; payload: { conversationId: string; activeId: string | null; replacement?: Conversation } }
  | { type: 'status'; payload: StatusEvent }
  | { type: 'statuses'; payload: StatusEvent[] }

/**
 * Apply one small server event to the store. Returns null when it can't be
 * applied faithfully -- a reply's tail for a thread we hold too little of --
 * so the caller re-fetches the whole store instead of guessing.
 */
export function applyEvent(s: ConversationStore, event: ServerEvent): ConversationStore | null {
  switch (event.type) {
    case 'conversations':
      return event.payload
    case 'active':
      return s.items.some((c) => c.id === event.payload.activeId) ? { ...s, activeId: event.payload.activeId } : s
    case 'tail': {
      const { conversationId, base, messages, meta } = event.payload
      const conv = s.items.find((c) => c.id === conversationId)
      if (!conv) return s // a thread we don't list; the next snapshot will say
      if (conv.messages.length < base) return null
      const next: Conversation = { ...conv, ...meta, messages: [...conv.messages.slice(0, base), ...messages] }
      return { ...s, items: s.items.map((c) => (c.id === conversationId ? next : c)) }
    }
    case 'patch': {
      const { conversationId, meta } = event.payload
      return { ...s, items: s.items.map((c) => (c.id === conversationId ? { ...c, ...meta, messages: c.messages } : c)) }
    }
    case 'created': {
      const { conversation, activeId } = event.payload
      const items = s.items.some((c) => c.id === conversation.id)
        ? s.items.map((c) => (c.id === conversation.id ? conversation : c))
        : [conversation, ...s.items]
      return { items, activeId }
    }
    case 'removed': {
      const { conversationId, activeId, replacement } = event.payload
      const items = s.items.filter((c) => c.id !== conversationId)
      return { items: replacement ? [replacement, ...items] : items, activeId }
    }
    default:
      return s
  }
}

const toChatStatus = (e: StatusEvent): ChatStatus =>
  ({ state: e.state as Status['state'], text: e.text, startedAt: e.startedAt })

const post = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export default function useServerState(): ServerState {
  const [store, setStore] = useState<ConversationStore>({ items: [], activeId: null })
  const [config, setConfig] = useState<PublicConfig | null>(null)
  // Status is per chat: switching away from one that's replying must neither
  // lock the next chat's composer nor lose the first one's progress.
  const [statuses, setStatuses] = useState<Record<string, ChatStatus>>({})
  const [link, setLink] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const [connected, setConnected] = useState(false)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = store.activeId

  const refreshConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/config')
      if (r.ok) setConfig(await r.json() as PublicConfig)
    } catch { /* the events stream reports connection health */ }
  }, [])

  useEffect(() => { void refreshConfig() }, [refreshConfig])

  // The latest store, for applying events in order as they arrive -- each
  // one builds on the last, and some decide whether to re-fetch.
  const storeRef = useRef(store)
  const commitStore = useCallback((next: ConversationStore) => {
    storeRef.current = next
    setStore(next)
  }, [])

  /** Fetch the whole store, when a small update couldn't be applied. */
  const resync = useCallback(async () => {
    try {
      const r = await fetch('/api/chats')
      if (r.ok) commitStore(await r.json() as ConversationStore)
    } catch { /* the next event or reconnect will try again */ }
  }, [commitStore])

  // Subscribe to server state. EventSource reconnects on its own, so a phone
  // that slept simply picks the stream back up.
  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onopen = () => {
      setConnected(true)
      setLink('live')
    }

    source.onmessage = (e: MessageEvent<string>) => {
      // Anything arriving proves the stream is up, whatever onopen said.
      setLink('live')
      const event = JSON.parse(e.data) as ServerEvent
      if (event.type !== 'status' && event.type !== 'statuses') {
        // Decided here, not in a state updater, which React may run later.
        const next = applyEvent(storeRef.current, event)
        if (next) commitStore(next)
        else void resync()
        return
      }
      if (event.type === 'statuses') {
        // A (re)connect snapshot of every chat mid-reply. Anything we thought
        // was in flight but isn't listed finished while we were away; keep
        // only the settled outcomes ("stopped", "auth failed") we already had.
        setStatuses((prev) => {
          const next: Record<string, ChatStatus> = {}
          for (const [id, st] of Object.entries(prev)) if (st.state !== 'pending') next[id] = st
          for (const e of event.payload) next[e.conversationId] = toChatStatus(e)
          return next
        })
        return
      }
      const update = event.payload
      setStatuses((prev) => ({ ...prev, [update.conversationId]: toChatStatus(update) }))
    }

    source.onerror = () => {
      setConnected(false)
      setLink('reconnecting')
    }

    return () => source.close()
  }, [resync, commitStore])

  const active = store.items.find((c) => c.id === store.activeId) ?? null
  const mine = store.activeId ? statuses[store.activeId] : undefined
  // A lost connection outranks any chat's last word; otherwise show the
  // active chat's own status, or plain "connected" if it has none.
  const status: Status = link !== 'live'
    ? { state: '', text: link === 'connecting' ? 'connecting...' : 'reconnecting...' }
    : mine ? { state: mine.state, text: mine.text } : { state: 'live', text: 'connected' }
  const working = Object.fromEntries(
    Object.entries(statuses).filter(([, st]) => st.state === 'pending'),
  )

  const send = useCallback(async (text: string) => {
    const id = activeIdRef.current
    if (!id) return
    setStatuses((prev) => ({ ...prev, [id]: { state: 'pending', text: 'sending...', startedAt: prev[id]?.startedAt ?? null } }))
    await post(`/api/chats/${encodeURIComponent(id)}/turns`, { text })
  }, [])

  const retry = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    setStatuses((prev) => ({ ...prev, [id]: { state: 'pending', text: 'retrying...', startedAt: prev[id]?.startedAt ?? null } }))
    await post(`/api/chats/${encodeURIComponent(id)}/retry`)
  }, [])

  const stop = useCallback(async () => {
    const id = activeIdRef.current
    if (id) await post(`/api/chats/${encodeURIComponent(id)}/stop`)
  }, [])

  const newChat = useCallback(async () => { await post('/api/chats') }, [])

  const openChat = useCallback(async (id: string) => {
    // Switch now; the server's confirmation is only for other devices.
    const s = storeRef.current
    if (s.items.some((c) => c.id === id)) commitStore({ ...s, activeId: id })
    await post(`/api/chats/${encodeURIComponent(id)}/active`)
  }, [commitStore])

  const deleteChat = useCallback(async (id: string) => {
    await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }, [])

  const restoreChat = useCallback(async (conversation: Conversation) => {
    await post('/api/chats/restore', conversation)
  }, [])

  const patchChat = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  const renameChat = useCallback(async (id: string, name: string) => {
    await patchChat(id, { name: name.trim() })
  }, [])

  const setReasoning = useCallback(async (value: string | null) => {
    const id = activeIdRef.current
    if (id) await patchChat(id, { reasoning: value })
  }, [])

  const saveConfig = useCallback(async (patch: Partial<PublicConfig> & { apiToken?: string }) => {
    const r = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (r.ok) setConfig(await r.json() as PublicConfig)
  }, [])

  return {
    conversations: [...store.items].sort((a, b) => b.updatedAt - a.updatedAt),
    activeId: store.activeId,
    active,
    config,
    status,
    startedAt: mine?.startedAt ?? null,
    connected,
    busy: mine?.startedAt != null,
    working,
    send,
    stop,
    retry,
    newChat,
    openChat,
    deleteChat,
    restoreChat,
    renameChat,
    setReasoning,
    saveConfig,
    refreshConfig,
  }
}
