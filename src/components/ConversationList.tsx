import { useState } from 'react'
import { Drawer } from 'vaul'
import { motion } from 'motion/react'
import { Trash2, Pencil, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import type { Conversation } from '../types.ts'
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
}

interface ConversationListProps {
  open: boolean
  conversations: Conversation[]
  activeId: string | null
  /** Chats with a reply in flight, by id. */
  working?: Record<string, ChatStatus>
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  /** Undo a deletion, from the copy the list still holds. */
  onRestore?: (conv: Conversation) => void
  onRename: (id: string, name: string) => void
  onClose: () => void
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const ACTIONS_WIDTH = 132

function Row({ conv, isActive, status, onOpen, onDelete, onRestore, onRename }: RowProps) {
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
        {status ? (
          <span className="conv-working" title={status.text}>
            <span className="dot pending" aria-hidden="true" />
            {status.text.startsWith('waiting') ? 'queued' : 'replying'}
          </span>
        ) : (
          <span className="conv-time">
            {count > 0 ? `${count} msgs · ` : ''}{relTime(conv.updatedAt)}
          </span>
        )}
      </motion.button>

      {/* With a mouse there's nothing to swipe: the same actions appear on
          hover (CSS shows them only on devices that can hover). */}
      {/* aria-hidden: a mouse-only duplicate of the actions above, which
          keyboards and screen readers already reach. */}
      <div className="conv-hover-actions" aria-hidden="true">
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

export default function ConversationList({
  open, conversations, activeId, working = {}, onOpen, onDelete, onRestore = () => {}, onRename, onClose,
}: ConversationListProps) {
  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Chats</Drawer.Title>
          <div className="conv-list drawer-scroll" data-vaul-no-drag>
            {conversations.map((c) => (
              <Row
                key={c.id}
                conv={c}
                isActive={c.id === activeId}
                status={working[c.id]}
                onOpen={(id) => { onOpen(id); onClose() }}
                onDelete={onDelete}
                onRestore={onRestore}
                onRename={onRename}
              />
            ))}
          </div>
          <div className="drawer-actions">
            <div className="hint drawer-foot">
              <span className="touch-only">Swipe a row left to rename or delete.</span>
              <span className="pointer-only">Hover a row to rename or delete; Delete removes the focused chat.</span>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
