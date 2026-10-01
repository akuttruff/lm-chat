import { useState } from 'react'
import { Drawer } from 'vaul'
import { motion } from 'motion/react'
import { Trash2, Pencil, MessageSquare, Star, FolderInput, Ghost } from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation, Folder } from '../types.ts'
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
  onRename: (id: string, name: string) => void
  onStar?: (id: string, starred: boolean) => void
  onOpenFolderPicker?: (id: string) => void
  onClose: () => void
}

/** "Sep 28, 2026, 8:15 PM" -- unambiguous, unlike a relative "2h" that keeps sliding as you read the list. */
export function fullDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
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
        {status ? (
          <span className="conv-working" title={status.text}>
            <span className="dot pending" aria-hidden="true" />
            {status.text.startsWith('waiting') ? 'queued' : 'replying'}
          </span>
        ) : (
          <span className="conv-time">
            {count > 0 ? `${count} msgs · ` : ''}{fullDateTime(conv.updatedAt)}
          </span>
        )}
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

interface Section {
  key: string
  /** Null for the flat, no-folders-in-use case: no header at all. */
  label: string | null
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
    if (chats?.length) sections.push({ key: f.id, label: f.name, chats })
  }
  if (unfiled.length) sections.push({ key: '__unfiled', label: sections.length ? 'Unfiled' : null, chats: unfiled })
  return sections
}

export default function ConversationList({
  open, conversations, activeId, folders, working = {}, onOpen, onDelete, onRestore = () => {}, onRename,
  onStar = () => {}, onOpenFolderPicker = () => {}, onClose,
}: ConversationListProps) {
  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Chats</Drawer.Title>
          <div className="conv-list drawer-scroll" data-vaul-no-drag>
            {sectionsOf(conversations, folders).map((section) => (
              <div key={section.key}>
                {section.label && <div className="conv-section-head">{section.label}</div>}
                {section.chats.map((c) => (
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
                ))}
              </div>
            ))}
          </div>
          <div className="drawer-actions">
            <div className="hint drawer-foot">
              <span className="touch-only">Swipe a row left to star, move, rename or delete.</span>
              <span className="pointer-only">Hover a row to star, move, rename or delete; Delete removes the focused chat.</span>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
