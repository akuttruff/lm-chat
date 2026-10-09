import { useState, useEffect, useRef } from 'react'
import { Menu, Plus } from 'lucide-react'
import type { Status } from '../types.ts'

interface HeaderProps {
  status: Status
  /** When a reply is in flight, so the header can tick out the wait. */
  startedAt: number | null
  /** The open chat's name; the app's own name when there is none. */
  title?: string
  onNewChat: () => void
  /** Absent when the chat list is already on screen beside the thread. */
  onOpenChats?: () => void
  /** Rename the open chat, from its name in the header: tap it, type, press Enter. */
  onRename?: (name: string) => void
}

export default function Header({
  status, startedAt, title, onNewChat, onOpenChats, onRename,
}: HeaderProps) {
  const dotClass = `dot${status.state ? ` ${status.state}` : ''}`
  const [elapsed, setElapsed] = useState(0)
  // Renaming in place: the name turns into a field; Enter or leaving it saves, Escape drops it.
  const [draft, setDraft] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)
  const editing = draft !== null
  // Select the whole name once, as the field opens -- not on every keystroke.
  useEffect(() => { if (editing) field.current?.select() }, [editing])
  const commit = (): void => {
    if (draft === null) return
    const next = draft.trim()
    if (next && next !== title) onRename?.(next)
    setDraft(null)
  }

  // A long wait with a static label is indistinguishable from a hang; a
  // ticking counter shows the app is still waiting on purpose.
  useEffect(() => {
    if (!startedAt) { setElapsed(0); return undefined }
    setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [startedAt])

  return (
    <header className="app-header">
      {onOpenChats && (
        <button className="icon-btn" onClick={onOpenChats} aria-label="Chats">
          <Menu size={18} aria-hidden="true" />
        </button>
      )}
      <div className="brand">
        {/* The chat's name, so you always know where you are; the app's name only on an empty screen. */}
        {draft !== null ? (
          <input
            ref={field}
            className="name name-edit"
            value={draft}
            aria-label="Chat name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              if (e.key === 'Escape') { e.preventDefault(); setDraft(null) }
            }}
          />
        ) : onRename && title ? (
          <button type="button" className="name name-btn" title="Rename this chat" aria-label={`Rename chat: ${title}`} onClick={() => setDraft(title)}>
            {title}
          </button>
        ) : (
          <div className="name" title={title}>{title || 'LM Chat'}</div>
        )}
        <div className="status">
          <span className={dotClass} />
          <span>{status.text}{startedAt ? ` · ${elapsed}s` : ''}</span>
        </div>
      </div>
      <div className="header-actions">
        <button className="icon-btn" onClick={onNewChat} aria-label="New chat">
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
