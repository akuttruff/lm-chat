import { useState, useEffect, useCallback, useRef } from 'react'
import type { Conversation, ConversationStore, PublicConfig, Status } from '../types.ts'

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
  status: Status
  startedAt: number | null
  connected: boolean
  busy: boolean
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  newChat: () => Promise<void>
  openChat: (id: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  renameChat: (id: string, name: string) => Promise<void>
  setReasoning: (value: string | null) => Promise<void>
  saveConfig: (patch: Partial<PublicConfig> & { apiToken?: string }) => Promise<void>
  refreshConfig: () => Promise<void>
}

const post = (url: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export default function useServerState(): ServerState {
  const [store, setStore] = useState<ConversationStore>({ items: [], activeId: null })
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [status, setStatus] = useState<Status>({ state: '', text: 'connecting...' })
  const [startedAt, setStartedAt] = useState<number | null>(null)
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

  // Subscribe to server state. EventSource reconnects on its own, so a phone
  // that slept simply picks the stream back up.
  useEffect(() => {
    const source = new EventSource('/api/events')

    source.onopen = () => {
      setConnected(true)
      setStatus((s) => (s.text === 'connecting...' ? { state: 'live', text: 'connected' } : s))
    }

    source.onmessage = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as
        | { type: 'conversations'; payload: ConversationStore }
        | { type: 'conversation'; payload: Conversation }
        | { type: 'status'; payload: { conversationId: string; state: string; text: string; startedAt: number | null } }
      if (event.type === 'conversations') {
        setStore(event.payload)
        return
      }
      if (event.type === 'conversation') {
        // One thread changed (a reply streaming): swap just that one in.
        const next = event.payload
        setStore((s) => (s.items.some((c) => c.id === next.id)
          ? { ...s, items: s.items.map((c) => (c.id === next.id ? next : c)) }
          : s))
        return
      }
      // Status belongs to one thread; ignore chatter about others.
      if (event.payload.conversationId !== activeIdRef.current) return
      setStatus({ state: event.payload.state as Status['state'], text: event.payload.text })
      setStartedAt(event.payload.startedAt)
    }

    source.onerror = () => {
      setConnected(false)
      setStatus({ state: '', text: 'reconnecting...' })
    }

    return () => source.close()
  }, [])

  const active = store.items.find((c) => c.id === store.activeId) ?? null

  const send = useCallback(async (text: string) => {
    const id = activeIdRef.current
    if (!id) return
    setStatus({ state: 'pending', text: 'sending...' })
    await post(`/api/chats/${encodeURIComponent(id)}/turns`, { text })
  }, [])

  const stop = useCallback(async () => {
    const id = activeIdRef.current
    if (id) await post(`/api/chats/${encodeURIComponent(id)}/stop`)
  }, [])

  const newChat = useCallback(async () => { await post('/api/chats') }, [])

  const openChat = useCallback(async (id: string) => {
    await post(`/api/chats/${encodeURIComponent(id)}/active`)
  }, [])

  const deleteChat = useCallback(async (id: string) => {
    await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
    startedAt,
    connected,
    busy: startedAt !== null,
    send,
    stop,
    newChat,
    openChat,
    deleteChat,
    renameChat,
    setReasoning,
    saveConfig,
    refreshConfig,
  }
}
