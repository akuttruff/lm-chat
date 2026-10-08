import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import { motion } from 'motion/react'
import { Trash2, Pencil, MessageSquare, Star, FolderInput, Ghost, Plus, CheckSquare, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation, Folder, SearchHit } from '../types.ts'
import type { ChatStatus } from '../hooks/useServerState.ts'

interface RowProps {
  conv: Conversation
  isActive: boolean
  /** Set while this chat has a reply in flight. */
  status?: ChatStatus
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRestore: (conv: Conversation) => void
  onRename: (id: string, name: string) => void
  onStar: (id: string, starred: boolean) => void
  onOpenFolderPicker: (id: string) => void
}

interface ConversationListProps {
  open: boolean
  conversations: Conversation[]
  activeId: string | null
  folders: Folder[]
  /** Chats with a reply in flight, by id. */
  working?: Record<string, ChatStatus>
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  /** Undo a deletion, from the copy the list still holds. */
  onRestore?: (conv: Conversation) => void
  /** Select mode: delete the chosen chats in one go, and put them all back on Undo. */
  onDeleteMany?: (ids: string[]) => Promise<void>
  /** The search box: chats containing the words, best first. */
  onSearch?: (query: string) => Promise<SearchHit[]>
  /** Open a chat at one of its messages (a search hit); `messageId` is null for a hit on the name alone. */
  onOpenAt?: (id: string, messageId: string | null) => void
  onRestoreMany?: (convs: Conversation[]) => Promise<void>
  onRename: (id: string, name: string) => void
  onStar?: (id: string, starred: boolean) => void
  onOpenFolderPicker?: (id: string) => void
  /** Start a chat filed into this folder, from the + on its header. */
  onNewChat?: (folderId: string) => void
  onClose: () => void
}

/** "Sep 28, 2026, 8:15 PM" -- unambiguous, unlike a relative "2h" that keeps sliding as you read the list. */
export function fullDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

/**
 * The same moment, as short as it can be while staying put: "8:15 PM" today,
 * "Tue 8:15 PM" within the week, "Sep 28" this year, "Sep 28, 2025" before.
 * Nothing here slides as you read, unlike "2h ago"; it only changes at midnight.
 */
export function shortDateTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const today = new Date(now)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return time
  const days = (today.setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86_400_000
  if (days > 0 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  if (d.getFullYear() === new Date(now).getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Four revealed buttons now (star, folder, rename, delete) -- wide enough
// that the drag can't be dismissed by a swipe that only clears a shorter span.
const ACTIONS_WIDTH = 246

function Row({ conv, isActive, status, onOpen, onDelete, onRestore, onRename, onStar, onOpenFolderPicker }: RowProps) {
  const [dragged, setDragged] = useState(false)
  // Only the open chat's messages are loaded; the rest carry a count.
  const count = conv.messageCount ?? conv.messages.length

  // Shared by the swipe actions, the hover buttons and the keyboard.
  const rename = (): void => {
    const next = window.prompt('Rename chat', conv.name || '')
    if (next !== null && next.trim()) {
      onRename(conv.id, next)
      toast.success('Renamed')
    }
    setDragged(false)
  }
  const remove = (): void => {
    const snapshot = conv
    onDelete(conv.id)
    toast('Chat deleted', { action: { label: 'Undo', onClick: () => onRestore(snapshot) } })
  }
  const toggleStar = (): void => onStar(conv.id, !conv.starred)
  const openFolderPicker = (): void => { setDragged(false); onOpenFolderPicker(conv.id) }

  return (
    <div className="conv-row-wrap">
      {/* Not aria-hidden: a swipe is the touch affordance, but keyboard and
          screen-reader users need these reachable too, so focus reveals them. */}
      <div
        className="conv-actions"
        onFocus={() => setDragged(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragged(false)
        }}
      >
        <button
          type="button"
          className={conv.starred ? 'starred' : ''}
          aria-label={conv.starred ? `Unstar ${conv.name || 'New chat'}` : `Star ${conv.name || 'New chat'}`}
          onClick={toggleStar}
        >
          <Star size={15} aria-hidden="true" fill={conv.starred ? 'currentColor' : 'none'} />
        </button>
        <button type="button" aria-label={`Move ${conv.name || 'New chat'} to a folder`} onClick={openFolderPicker}>
          <FolderInput size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label={`Rename ${conv.name || 'New chat'}`} onClick={rename}>
          <Pencil size={15} aria-hidden="true" />
        </button>
        <button type="button" className="danger" aria-label={`Delete ${conv.name || 'New chat'}`} onClick={remove}>
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>

      <motion.button
        type="button"
        className={`conv-row${isActive ? ' active' : ''}`}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -ACTIONS_WIDTH, right: 0 }}
        // No elastic and no momentum: a row must not drift past its bounds or
        // keep gliding after the finger lifts, which read as the list wobbling
        // while scrolling vertically.
        dragElastic={0}
        dragMomentum={false}
        dragPropagation={false}
        animate={{ x: dragged ? -ACTIONS_WIDTH : 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 40 }}
        onDragEnd={(_event, info) => setDragged(info.offset.x < -ACTIONS_WIDTH / 2)}
        onClick={() => (dragged ? setDragged(false) : onOpen(conv.id))}
        onKeyDown={(e) => {
          // Desktop: Delete (or Backspace, on a Mac keyboard) removes the focused chat.
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            remove()
          }
        }}
      >
        <MessageSquare size={15} className="conv-glyph" aria-hidden="true" />
        <span className="conv-main">
          <span className="conv-name-row">
            <span className="conv-name">{conv.name || 'New chat'}</span>
            {/* A plain indicator, not a control: the actual toggle lives in the
                actions above/below, reachable by swipe, hover or keyboard focus --
                two interactive buttons can't nest inside this row's own button. */}
            {conv.starred && <Star size={12} className="conv-star" aria-hidden="true" fill="currentColor" />}
            {/* Nothing about a temporary chat is on disk -- worth knowing at a glance, not just while you're in it. */}
            {conv.temporary && (
              <span className="conv-temporary" role="img" aria-label="Temporary: not being saved">
                <Ghost size={12} aria-hidden="true" />
              </span>
            )}
          </span>
          {/* The second line stays quiet so the names are what the eye lands on. */}
          {status ? (
            <span className="conv-working" title={status.text}>
              <span className="dot pending" aria-hidden="true" />
              {status.text.startsWith('waiting') ? 'queued' : 'replying'}
            </span>
          ) : (
            <span className="conv-time" title={fullDateTime(conv.updatedAt)}>
              {count > 0 ? `${count} msgs · ` : ''}{shortDateTime(conv.updatedAt)}
            </span>
          )}
        </span>
      </motion.button>

      {/* With a mouse there's nothing to swipe: the same actions appear on
          hover (CSS shows them only on devices that can hover). */}
      {/* aria-hidden: a mouse-only duplicate of the actions above, which
          keyboards and screen readers already reach. */}
      <div className="conv-hover-actions" aria-hidden="true">
        <button
          type="button"
          tabIndex={-1}
          className={conv.starred ? 'starred' : ''}
          aria-label={conv.starred ? `Unstar ${conv.name || 'New chat'}` : `Star ${conv.name || 'New chat'}`}
          title={conv.starred ? 'Unstar' : 'Star'}
          onClick={toggleStar}
        >
          <Star size={14} aria-hidden="true" fill={conv.starred ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Move ${conv.name || 'New chat'} to a folder`}
          title="Move to folder"
          onClick={openFolderPicker}
        >
          <FolderInput size={14} aria-hidden="true" />
        </button>
        <button type="button" tabIndex={-1} aria-label={`Rename ${conv.name || 'New chat'}`} title="Rename" onClick={rename}>
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button type="button" tabIndex={-1} className="danger" aria-label={`Delete ${conv.name || 'New chat'}`} title="Delete" onClick={remove}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/**
 * A row in select mode: the whole row toggles the chat's checkbox. No swipe
 * and no row actions -- the bar at the top acts on the selection instead.
 */
function SelectRow({ conv, checked, onToggle }: { conv: Conversation; checked: boolean; onToggle: (id: string) => void }) {
  const count = conv.messageCount ?? conv.messages.length
  return (
    <label className={`conv-row conv-select-row${checked ? ' checked' : ''}`}>
      <input type="checkbox" checked={checked} onChange={() => onToggle(conv.id)} aria-label={conv.name || 'New chat'} />
      <span className="conv-main">
        <span className="conv-name-row">
          <span className="conv-name">{conv.name || 'New chat'}</span>
          {conv.starred && <Star size={12} className="conv-star" aria-hidden="true" fill="currentColor" />}
        </span>
        <span className="conv-time" title={fullDateTime(conv.updatedAt)}>{count > 0 ? `${count} msgs · ` : ''}{shortDateTime(conv.updatedAt)}</span>
      </span>
    </label>
  )
}

interface Section {
  key: string
  /** Null for the flat, no-folders-in-use case: no header at all. */
  label: string | null
  /** The folder this section is, or null for the unfiled chats. */
  folderId: string | null
  chats: Conversation[]
}

/**
 * `conversations` arrives already sorted (starred first, then recency); this
 * only regroups it by folder, so each section keeps that same order inside
 * it. A folder with nothing in it isn't shown here -- it's still there to
 * file something into, from the picker, just not a section to scroll past.
 */
function sectionsOf(conversations: Conversation[], folders: Folder[]): Section[] {
  const byFolder = new Map<string, Conversation[]>()
  const unfiled: Conversation[] = []
  const known = new Set(folders.map((f) => f.id))
  for (const c of conversations) {
    if (c.folderId && known.has(c.folderId)) {
      const list = byFolder.get(c.folderId)
      if (list) list.push(c)
      else byFolder.set(c.folderId, [c])
    } else {
      unfiled.push(c)
    }
  }
  const sections: Section[] = []
  for (const f of folders) {
    const chats = byFolder.get(f.id)
    if (chats?.length) sections.push({ key: f.id, label: f.name, folderId: f.id, chats })
  }
  if (unfiled.length) sections.push({ key: '__unfiled', label: sections.length ? 'Unfiled' : null, folderId: null, chats: unfiled })
  return sections
}

/** The query's occurrences in `text` marked, case-insensitively. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim()
  if (!q) return text
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
  return parts.map((part, i) => (part.toLowerCase() === q.toLowerCase() ? <mark key={i}>{part}</mark> : part))
}

export default function ConversationList({
  open, conversations, activeId, folders, working = {}, onOpen, onDelete, onRestore = () => {}, onRename,
  onStar = () => {}, onOpenFolderPicker = () => {}, onNewChat, onDeleteMany, onRestoreMany, onClose, onSearch, onOpenAt,
}: ConversationListProps) {
  // The search box: results replace the list while there's a query.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const searching = query.trim().length > 0
  useEffect(() => {
    if (!onSearch || !searching) { setHits(null); return undefined }
    let live = true
    const t = setTimeout(() => {
      onSearch(query.trim()).then((found) => { if (live) setHits(found) }).catch(() => { if (live) setHits([]) })
    }, 150)
    return () => { live = false; clearTimeout(t) }
  }, [query, searching, onSearch])
  useEffect(() => { if (!open) setQuery('') }, [open])
  const openHit = (hit: SearchHit): void => {
    if (onOpenAt) onOpenAt(hit.id, hit.match?.messageId ?? null)
    else onOpen(hit.id)
    onClose()
  }
  // Select mode: null when off, else the chosen chat ids.
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const selecting = selected !== null
  // Closing the drawer leaves select mode, so it opens to the normal list next time.
  useEffect(() => { if (!open) setSelected(null) }, [open])
  // Chats deleted elsewhere (another tab, or this very delete) drop out of the selection.
  const live = new Set(conversations.map((c) => c.id))
  const chosen = selected ? [...selected].filter((id) => live.has(id)) : []

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  /** Every chat in a group on, or -- when they're all on already -- off. */
  const toggleGroup = (ids: string[]): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allOn) next.delete(id)
        else next.add(id)
      }
      return next
    })

  const deleteChosen = async (): Promise<void> => {
    if (!onDeleteMany || !chosen.length) return
    // Kept in list order, so Undo restores them oldest-first and the list rebuilds as it was.
    const snapshots = conversations.filter((c) => chosen.includes(c.id)).reverse()
    try {
      await onDeleteMany(chosen)
      setSelected(null)
      const n = snapshots.length
      toast(`${n} ${n === 1 ? 'chat' : 'chats'} deleted`, {
        action: { label: 'Undo', onClick: () => { void onRestoreMany?.(snapshots) } },
        duration: 10_000,
      })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <div className="conv-title-row">
            <Drawer.Title className="drawer-title">Chats</Drawer.Title>
            {onDeleteMany && conversations.length > 0 && (
              <button
                type="button"
                className="conv-select-toggle"
                onClick={() => setSelected(selecting ? null : new Set())}
                aria-pressed={selecting}
              >
                {selecting ? 'Done' : <><CheckSquare size={14} aria-hidden="true" /> Select</>}
              </button>
            )}
          </div>
          {selecting && (
            <div className="conv-select-bar" role="toolbar" aria-label="Selected chats">
              <button type="button" className="link" onClick={() => setSelected(new Set(conversations.map((c) => c.id)))}>Select all</button>
              <button type="button" className="link" onClick={() => setSelected(new Set())} disabled={!chosen.length}>Deselect all</button>
              <span className="conv-select-count">{chosen.length} selected</span>
              <button
                type="button"
                className="conv-select-delete"
                onClick={() => void deleteChosen()}
                disabled={!chosen.length}
              >
                <Trash2 size={14} aria-hidden="true" /> Delete{chosen.length ? ` ${chosen.length}` : ''}
              </button>
            </div>
          )}
          {onSearch && (
            <div className="conv-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                autoComplete="off"
                autoCorrect="off"
                enterKeyHint="search"
              />
              {query && (
                <button type="button" className="conv-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          )}
          {searching && (
            <div className="conv-list drawer-scroll" data-vaul-no-drag aria-live="polite">
              {hits === null && <div className="conv-empty">Searching…</div>}
              {hits?.length === 0 && <div className="conv-empty">No chats mention &ldquo;{query.trim()}&rdquo;.</div>}
              {hits?.map((hit) => (
                <button key={hit.id} type="button" className={`conv-hit${hit.id === activeId ? ' active' : ''}`} onClick={() => openHit(hit)}>
                  <span className="conv-hit-name">{highlight(hit.name || 'New chat', query)}</span>
                  {hit.match && (
                    <span className="conv-hit-excerpt">
                      <span className="conv-hit-role">{hit.match.role === 'user' ? 'You' : 'Reply'}:</span> {highlight(hit.match.excerpt, query)}
                    </span>
                  )}
                  {hit.count > 1 && <span className="conv-hit-count">{hit.count} messages</span>}
                </button>
              ))}
            </div>
          )}
          <div className="conv-list drawer-scroll" data-vaul-no-drag hidden={searching}>
            {sectionsOf(conversations, folders).map((section) => (
              <div key={section.key}>
                {section.label && (
                  <div className="conv-section-head">
                    {selecting ? (
                      <label className="conv-section-select">
                        <input
                          type="checkbox"
                          checked={section.chats.every((c) => selected!.has(c.id))}
                          ref={(el) => {
                            if (el) {
                              const n = section.chats.filter((c) => selected!.has(c.id)).length
                              el.indeterminate = n > 0 && n < section.chats.length
                            }
                          }}
                          onChange={() => toggleGroup(section.chats.map((c) => c.id))}
                          aria-label={`Select every chat in ${section.label}`}
                        />
                        <span>{section.label}</span>
                      </label>
                    ) : (
                      <span>{section.label}</span>
                    )}
                    {/* Start a chat already filed here, so the folder's reasoning and tools apply from the first message. */}
                    {section.folderId && onNewChat && !selecting && (
                      <button
                        type="button"
                        className="conv-section-add"
                        aria-label={`New chat in ${section.label}`}
                        title={`New chat in ${section.label}`}
                        onClick={() => { onNewChat(section.folderId!); onClose() }}
                      >
                        <Plus size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
                {section.chats.map((c) => (selecting ? (
                  <SelectRow key={c.id} conv={c} checked={selected!.has(c.id)} onToggle={toggle} />
                ) : (
                  <Row
                    key={c.id}
                    conv={c}
                    isActive={c.id === activeId}
                    status={working[c.id]}
                    onOpen={(id) => { onOpen(id); onClose() }}
                    onDelete={onDelete}
                    onRestore={onRestore}
                    onRename={onRename}
                    onStar={onStar}
                    onOpenFolderPicker={onOpenFolderPicker}
                  />
                )))}
              </div>
            ))}
          </div>
          <div className="drawer-actions">
            <div className="hint drawer-foot">
              {selecting ? (
                <span>Tap chats to select them, or a folder&apos;s box for all of its chats.</span>
              ) : (
                <>
                  <span className="touch-only">Swipe a row left to star, move, rename or delete.</span>
                  <span className="pointer-only">Hover a row to star, move, rename or delete; Delete removes the focused chat.</span>
                </>
              )}
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
