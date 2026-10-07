import { useState, useEffect } from 'react'
import { Menu, Plus, Settings, Trash2 } from 'lucide-react'
import type { Status } from '../types.ts'

interface HeaderProps {
  status: Status
  /** When a reply is in flight, so the header can tick out the wait. */
  startedAt: number | null
  onNewChat: () => void
  onOpenSettings: () => void
  onOpenChats: () => void
  /** Delete the chat that's open, without going to the drawer. Absent when there's no chat to delete. */
  onDeleteChat?: () => void
}

export default function Header({
  status, startedAt, onNewChat, onOpenSettings, onOpenChats, onDeleteChat,
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
      <button className="icon-btn" onClick={onOpenChats} aria-label="Chats">
        <Menu size={18} aria-hidden="true" />
      </button>
      <div className="brand">
        <div className="name">LM Chat</div>
        <div className="status">
          <span className={dotClass} />
          <span>{status.text}{startedAt ? ` · ${elapsed}s` : ''}</span>
        </div>
      </div>
      <div className="header-actions">
        {onDeleteChat && (
          <button className="icon-btn" onClick={onDeleteChat} aria-label="Delete this chat" title="Delete this chat">
            <Trash2 size={17} aria-hidden="true" />
          </button>
        )}
        <button className="icon-btn" onClick={onNewChat} aria-label="New chat">
          <Plus size={18} aria-hidden="true" />
        </button>
        <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
          <Settings size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
