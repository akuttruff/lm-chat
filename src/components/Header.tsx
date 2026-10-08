import { useState, useEffect } from 'react'
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
}

export default function Header({
  status, startedAt, title, onNewChat, onOpenChats,
}: HeaderProps) {
  const dotClass = `dot${status.state ? ` ${status.state}` : ''}`
  const [elapsed, setElapsed] = useState(0)

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
        <div className="name" title={title}>{title || 'LM Chat'}</div>
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
