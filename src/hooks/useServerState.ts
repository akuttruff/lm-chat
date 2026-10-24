import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type {
  Conversation, ConversationMeta, ConversationStore, Folder, FolderUpdate, ImageUpload, Message, PublicConfig, Status, SearchHit,
} from '../types.ts'
import { chime } from '../lib/chime.ts'
import type { ChimeTone } from '../lib/chime.ts'
import { reachFetch } from '../lib/reach.ts'

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
  /** The open chat is known, but its messages are still on their way (see listView on the server). */
  loadingActive: boolean
  config: PublicConfig | null
  /** The active chat's status (or the connection's, when it has none). */
  status: Status
  startedAt: number | null
  connected: boolean
  /** Whether the active chat has a reply in flight. Other chats stay usable. */
  busy: boolean
  /** Every chat with a reply in flight, keyed by id, e.g. for the chat list. */
  working: Record<string, ChatStatus>
  send: (text: string, images?: ImageUpload[]) => Promise<void>
  stop: () => Promise<void>
  /** Re-run the last message you sent, replacing the reply that followed it. */
  retry: () => Promise<void>
  /** The /compact command: summarize the whole chat so far; resolves with where the summary now ends. */
  compact: () => Promise<{ through: string | number; folded: number }>
  /** Send a changed version of a message you sent, in a new chat that picks up from there; this one stays as it is. */
  branch: (messageId: string, text: string) => Promise<void>
  /** Chats containing the words, best first. */
  search: (query: string) => Promise<SearchHit[]>
  /** A fresh chat; filed into `folderId` from the start when given, so that folder's defaults apply. */
  newChat: (folderId?: string | null) => Promise<void>
  openChat: (id: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
  /** Several at once (the drawer's select mode); each is kept for Undo like a single delete. */
  deleteChats: (ids: string[]) => Promise<void>
  /** Put back a conversation just deleted. The server restores its own full copy when it has one. */
  restoreChat: (conversation: Conversation) => Promise<void>
  renameChat: (id: string, name: string) => Promise<void>
  setReasoning: (value: string | null) => Promise<void>
  /** This chat's memory switch; null goes back to the Settings default. */
  setMemory: (value: boolean | null) => Promise<void>
  /** Which saved memories a chat injects; null goes back to automatic. */
  setMemorySelection: (id: string, value: string[] | null) => Promise<void>
  setStarred: (id: string, value: boolean) => Promise<void>
  /** Which folder a chat is filed under; null takes it out of any folder. */
  setFolder: (id: string, folderId: string | null) => Promise<void>
  /** On: nothing about this chat is saved from now on, and whatever was already saved for it is thrown away. Off: catches disk up with it. */
  setTemporary: (id: string, value: boolean) => Promise<void>
  /** This chat's own tool list (stored form; see lib/integrations.ts); null goes back to the folder's / Settings'. */
  setTools: (id: string, tools: string | null) => Promise<void>
  /** Every folder, name-sorted -- shared between the chat list (grouping) and the folder picker. */
  folders: Folder[]
  createFolder: (name: string) => Promise<Folder>
  /** Rename a folder or change its defaults; fields left out of the patch stay as they were. */
  updateFolder: (id: string, patch: FolderUpdate) => Promise<void>
  deleteFolder: (id: string) => Promise<void>
  saveConfig: (patch: Partial<PublicConfig> & { apiToken?: string }) => Promise<void>
  refreshConfig: () => Promise<void>
  /** Fetch again what a launch out of the server's reach could not: the config, the folders and the chats. */
  refresh: () => void
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
      // A chat held only in outline: keep its place and count current. Its
      // messages arrive in full if it's opened.
      if (conv.messagesOmitted) {
        const outline: Conversation = { ...conv, ...meta, messageCount: base + messages.length }
        return { ...s, items: s.items.map((c) => (c.id === conversationId ? outline : c)) }
      }
      if (conv.messages.length < base) return null
      const merged = [...conv.messages.slice(0, base), ...messages]
      const next: Conversation = { ...conv, ...meta, messages: merged, messageCount: merged.length }
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

/**
 * The chime a chat's new status calls for, if it just finished a reply:
 * rising for a reply that arrived, falling for one that failed. Stopping it
 * yourself makes no sound -- you were there to tap Stop.
 */
export function finishTone(wasPending: boolean, state: string, text: string): ChimeTone | null {
  if (!wasPending || state === 'pending') return null
  if (state === 'live') return 'done'
  return text === 'stopped' ? null : 'failed'
}

const toChatStatus = (e: StatusEvent): ChatStatus =>
  ({ state: e.state as Status['state'], text: e.text, startedAt: e.startedAt })

const post = (url: string, body?: unknown): Promise<Response> =>
  reachFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

export default function useServerState(): ServerState {
  const [store, setStore] = useState<ConversationStore>({ items: [], activeId: null })
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  // Status is per chat: switching away from one that's replying must neither
  // lock the next chat's composer nor lose the first one's progress.
  const [statuses, setStatuses] = useState<Record<string, ChatStatus>>({})
  const [link, setLink] = useState<'connecting' | 'live' | 'reconnecting'>('connecting')
  const [connected, setConnected] = useState(false)
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = store.activeId
  // Chats the server last reported as mid-reply, so a finish can be told
  // apart from a status that merely repeats (see finishTone).
  const pendingRef = useRef(new Set<string>())

  const refreshConfig = useCallback(async () => {
    try {
      const r = await reachFetch('/api/config')
      if (r.ok) setConfig(await r.json() as PublicConfig)
    } catch { /* the events stream reports connection health */ }
  }, [])

  useEffect(() => { void refreshConfig() }, [refreshConfig])

  const refreshFolders = useCallback(async () => {
    try {
      const r = await reachFetch('/api/folders')
      const list: unknown = r.ok ? await r.json() : []
      // A malformed response reads as "no folders" rather than crashing the
      // grouping in ConversationList, which trusts this is always an array.
      if (Array.isArray(list)) setFolders(list as Folder[])
    } catch { /* the drawer just shows an unfiled list */ }
  }, [])

  useEffect(() => { void refreshFolders() }, [refreshFolders])

  const byName = (list: Folder[]): Folder[] => [...list].sort((a, b) => a.name.localeCompare(b.name))

  const createFolder = useCallback(async (name: string): Promise<Folder> => {
    const r = await fetch('/api/folders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    })
    const body = await r.json() as Folder & { error?: string }
    if (!r.ok) throw new Error(body.error ?? 'Could not create folder')
    setFolders((list) => byName([...list, body]))
    return body
  }, [])

  const updateFolder = useCallback(async (id: string, patch: FolderUpdate): Promise<void> => {
    const r = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    })
    const body = await r.json() as Folder & { error?: string }
    if (!r.ok) throw new Error(body.error ?? 'Could not update folder')
    setFolders((list) => byName(list.map((f) => (f.id === id ? body : f))))
  }, [])

  const deleteFolder = useCallback(async (id: string): Promise<void> => {
    const r = await fetch(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!r.ok) throw new Error('Could not delete folder')
    setFolders((list) => list.filter((f) => f.id !== id))
  }, [])

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
      const r = await reachFetch('/api/chats')
      if (r.ok) commitStore(await r.json() as ConversationStore)
    } catch { /* the next event or reconnect will try again */ }
  }, [commitStore])

  // The server is answering again after a launch it missed: the stream
  // reconnects on its own, and these are the reads that went unanswered.
  const refresh = useCallback(() => {
    void refreshConfig()
    void refreshFolders()
    void resync()
  }, [refreshConfig, refreshFolders, resync])

  // The open chat arrives in outline (the server sends only its count), so
  // fetch its messages. Covers opening one here, another device switching,
  // and a reconnect's fresh snapshot alike. A reply streaming in meanwhile is
  // harmless: every tail resends the whole turn, so the next one fills in
  // anything this copy predates.
  const loading = useRef(new Set<string>())
  useEffect(() => {
    const conv = store.items.find((c) => c.id === store.activeId)
    if (!conv?.messagesOmitted || loading.current.has(conv.id)) return
    const id = conv.id
    loading.current.add(id)
    reachFetch(`/api/chats/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) return
        const full = await r.json() as Conversation
        const s = storeRef.current
        // Only the messages come from the fetch: a rename, star or move that
        // arrived while it was in flight is newer than the copy it answered.
        const withMessages = (c: Conversation): Conversation =>
          ({ ...c, messages: full.messages, messageCount: full.messages.length, messagesOmitted: false })
        commitStore({ ...s, items: s.items.map((c) => (c.id === id ? withMessages(c) : c)) })
      })
      .catch(() => { /* opening it again, or the next reconnect, will retry */ })
      .finally(() => loading.current.delete(id))
  }, [store, commitStore])

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
        // Replies that finished while we were away are not news to chime about.
        pendingRef.current = new Set(event.payload.filter((e) => e.state === 'pending').map((e) => e.conversationId))
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
      // Every device that's open chimes, and for any chat, not only the one
      // on screen: a reply you're waiting on elsewhere is still worth hearing.
      const tone = finishTone(pendingRef.current.has(update.conversationId), update.state, update.text)
      if (update.state === 'pending') pendingRef.current.add(update.conversationId)
      else pendingRef.current.delete(update.conversationId)
      if (tone) chime(tone)
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

  const send = useCallback(async (text: string, images?: ImageUpload[]) => {
    const id = activeIdRef.current
    if (!id) return
    setStatuses((prev) => ({ ...prev, [id]: { state: 'pending', text: 'sending...', startedAt: prev[id]?.startedAt ?? null } }))
    await post(`/api/chats/${encodeURIComponent(id)}/turns`, images?.length ? { text, images } : { text })
  }, [])

  const compact = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) throw new Error('No chat is open.')
    const res = await post(`/api/chats/${encodeURIComponent(id)}/compact`)
    const body = await res.json() as { ok?: boolean; summary?: { through: string | number }; folded?: number; error?: string }
    if (!res.ok || !body.summary) throw new Error(body.error ?? 'Compaction failed.')
    return { through: body.summary.through, folded: body.folded ?? 0 }
  }, [])

  const retry = useCallback(async () => {
    const id = activeIdRef.current
    if (!id) return
    setStatuses((prev) => ({ ...prev, [id]: { state: 'pending', text: 'retrying...', startedAt: prev[id]?.startedAt ?? null } }))
    await post(`/api/chats/${encodeURIComponent(id)}/retry`)
  }, [])

  const branch = useCallback(async (messageId: string, text: string) => {
    const id = activeIdRef.current
    if (!id) return
    const r = await post(`/api/chats/${encodeURIComponent(id)}/branch`, { messageId, text })
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Could not start the branch')
  }, [])

  const search = useCallback(async (query: string): Promise<SearchHit[]> => {
    const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
    if (!r.ok) return []
    return ((await r.json()) as { hits?: SearchHit[] }).hits ?? []
  }, [])

  const stop = useCallback(async () => {
    const id = activeIdRef.current
    if (id) await post(`/api/chats/${encodeURIComponent(id)}/stop`)
  }, [])

  const newChat = useCallback(async (folderId?: string | null) => {
    const r = await post('/api/chats', folderId ? { folderId } : {})
    if (!r.ok) return
    // Shown from the response, not only the stream's `created`: a stream that
    // is lagging or reconnecting made the press look like it did nothing, and
    // pressing again only re-blanked the same chat. The event, when it comes,
    // replaces this copy by id.
    const conv = await r.json() as Conversation
    if (typeof conv?.id !== 'string') return
    const next = applyEvent(storeRef.current, { type: 'created', payload: { conversation: conv, activeId: conv.id } })
    if (next) commitStore(next)
  }, [commitStore])

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

  const deleteChats = useCallback(async (ids: string[]) => {
    const r = await post('/api/chats/delete', { ids })
    if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? 'Could not delete those chats')
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

  const setMemory = useCallback(async (value: boolean | null) => {
    const id = activeIdRef.current
    if (id) await patchChat(id, { memory: value })
  }, [])

  const setMemorySelection = useCallback(async (id: string, value: string[] | null) => {
    await patchChat(id, { memorySelection: value })
  }, [])

  const setStarred = useCallback(async (id: string, value: boolean) => {
    await patchChat(id, { starred: value })
  }, [])

  const setFolder = useCallback(async (id: string, folderId: string | null) => {
    await patchChat(id, { folderId })
  }, [])

  const setTemporary = useCallback(async (id: string, value: boolean) => {
    await patchChat(id, { temporary: value })
  }, [])

  const setTools = useCallback(async (id: string, tools: string | null) => {
    await patchChat(id, { tools })
  }, [])

  const saveConfig = useCallback(async (patch: Partial<PublicConfig> & { apiToken?: string }) => {
    const r = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (r.ok) setConfig(await r.json() as PublicConfig)
  }, [])

  // Starred chats first, each group newest first. `starred` is optional --
  // Number(undefined) is NaN, which is falsy and silently skips the whole
  // comparison, so this needs Boolean() first, not just Number(). Memoised
  // on the items, so the list keeps its identity across renders that did
  // not change it (a status tick, a config save) and memos downstream hold.
  const conversations = useMemo(() => [...store.items].sort(
    (a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || b.updatedAt - a.updatedAt,
  ), [store.items])

  return {
    conversations,
    activeId: store.activeId,
    active,
    loadingActive: active?.messagesOmitted === true,
    config,
    status,
    startedAt: mine?.startedAt ?? null,
    connected,
    busy: mine?.startedAt != null,
    working,
    send,
    stop,
    retry,
    compact,
    branch,
    search,
    newChat,
    openChat,
    deleteChat,
    deleteChats,
    restoreChat,
    renameChat,
    setReasoning,
    setMemory,
    setMemorySelection,
    setStarred,
    setFolder,
    setTools,
    setTemporary,
    folders,
    createFolder,
    updateFolder,
    deleteFolder,
    saveConfig,
    refreshConfig,
    refresh,
  }
}
