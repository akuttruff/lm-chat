import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Ellipsis, Gauge, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Folder } from '../types.ts'

interface FolderHeadProps {
  /** What the header says: the folder's name, or "Unfiled". */
  label: string
  /** The folder this header is; null for the unfiled chats, which have no menu. */
  folder: Folder | null
  /** How many chats it holds, shown while it is folded. */
  count: number
  folded: boolean
  onToggle: () => void
  /** Start a chat filed here. */
  onNewChat?: () => void
  /** Rename the folder; throws with what to fix. */
  onRename?: (name: string) => Promise<void>
  /** Pick the reasoning level its chats start with. */
  onReasoning?: () => void
  /** Delete the folder (the parent asks about its chats, if it has any). */
  onDelete?: () => void
}

/**
 * A folder's header in the chat list, and the one place a folder is managed:
 * tap the name to fold it to a line with its count, + for a new chat in it,
 * and ⋯ for Rename (in place), Reasoning and Delete. The ⋯ shows on hover
 * on a desktop, always on a phone, like the buttons on a chat's row.
 */
export default function FolderHead({ label, folder, count, folded, onToggle, onNewChat, onRename, onReasoning, onDelete }: FolderHeadProps) {
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(label)
  const wrap = useRef<HTMLDivElement>(null)

  // A tap or click anywhere else, or Escape, closes the menu.
  useEffect(() => {
    if (!menu) return undefined
    const away = (e: PointerEvent): void => { if (!wrap.current?.contains(e.target as Node)) setMenu(false) }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc) }
  }, [menu])

  const pick = (fn?: () => void): void => { setMenu(false); fn?.() }

  const saveName = async (): Promise<void> => {
    const next = name.trim()
    if (!next || next === label || !onRename) { setRenaming(false); setName(label); return }
    try {
      await onRename(next)
      setRenaming(false)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (renaming) {
    return (
      <div className="conv-section-head renaming">
        <input
          className="conv-section-rename"
          aria-label={`New name for ${label}`}
          value={name}
          maxLength={60}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void saveName() }
            if (e.key === 'Escape') { setRenaming(false); setName(label) }
          }}
          onBlur={() => void saveName()}
        />
      </div>
    )
  }

  return (
    <div className="conv-section-head" ref={wrap}>
      <button
        type="button"
        className="conv-section-toggle"
        aria-expanded={!folded}
        title={folded ? `Show the chats in ${label}` : `Fold ${label}`}
        onClick={onToggle}
      >
        <ChevronRight size={13} aria-hidden="true" className="conv-section-chev" />
        <span className="conv-section-label">{label}</span>
        {folded && <span className="conv-section-count">{count}</span>}
      </button>
      {folder && (onRename || onReasoning || onDelete) && (
        <span className={`conv-section-more${menu ? ' open' : ''}`}>
          <button
            type="button"
            className="conv-section-btn"
            aria-label={`${label}: folder actions`}
            aria-haspopup="menu"
            aria-expanded={menu}
            title="Rename, reasoning, delete"
            onClick={() => setMenu((v) => !v)}
          >
            <Ellipsis size={15} aria-hidden="true" />
          </button>
          {menu && (
            <div className="more-menu folder-menu" role="menu" aria-label={`${label}: folder actions`}>
              {onRename && (
                <button type="button" role="menuitem" onClick={() => pick(() => { setName(label); setRenaming(true) })}>
                  <Pencil size={14} aria-hidden="true" /> Rename
                </button>
              )}
              {onReasoning && (
                <button type="button" role="menuitem" onClick={() => pick(onReasoning)}>
                  <Gauge size={14} aria-hidden="true" /> Reasoning{folder.reasoning ? ` (${folder.reasoning})` : ''}…
                </button>
              )}
              {onDelete && (
                <button type="button" role="menuitem" className="danger" onClick={() => pick(onDelete)}>
                  <Trash2 size={14} aria-hidden="true" /> Delete folder…
                </button>
              )}
            </div>
          )}
        </span>
      )}
      {folder && onNewChat && (
        <button
          type="button"
          className="conv-section-btn conv-section-add"
          aria-label={`New chat in ${label}`}
          title={`New chat in ${label}`}
          onClick={onNewChat}
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
