import { useEffect, useState } from 'react'
import type { Memory } from '../types.ts'

/** Everything remembered, asked for once the checklist is in view. */
export function useMemories(active: boolean): { items: Memory[] | null; error: string | null } {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!active || items) return
    let live = true
    fetch('/api/memories')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const list = await r.json() as Memory[]
        if (live) { setItems(list); setError(null) }
      })
      .catch((err: Error) => { if (live) setError(err.message) })
    return () => { live = false }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  return { items, error }
}

interface MemoryChecklistProps {
  items: Memory[] | null
  error: string | null
  /** The ids picked; an explicit list, never "automatic". */
  selection: string[]
  onChange: (selection: string[]) => void
}

/**
 * Saved memories as checkboxes, for a folder's defaults: which of them the
 * chats filed there start with. The Memories sheet does the same job for
 * one chat, with editing; this is the bare pick.
 */
export default function MemoryChecklist({ items, error, selection, onChange }: MemoryChecklistProps) {
  const toggle = (id: string): void =>
    onChange(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id])

  return (
    <div className="memory-checklist" aria-label="Memory checklist">
      {error && <div className="hint bad">Couldn&apos;t load memories: {error}</div>}
      {!items && !error && <div className="hint">Loading memories…</div>}
      {items?.length === 0 && <div className="hint">Nothing remembered yet.</div>}
      {items && items.length > 0 && (
        <div className="pick-all">
          <button type="button" className="link" onClick={() => onChange(items.map((m) => m.id))}>Select all</button>
          <button type="button" className="link" onClick={() => onChange([])}>Deselect all</button>
        </div>
      )}
      {items?.map((m) => (
        <label key={m.id} className="toggle-row memory-pick-row">
          <input type="checkbox" checked={selection.includes(m.id)} onChange={() => toggle(m.id)} aria-label={m.text} />
          <span className="memory-text">{m.text}</span>
        </label>
      ))}
    </div>
  )
}
