import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import { Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Memory } from '../types.ts'

interface MemorySelection {
  /** This chat's saved selection; null means automatic (the newest that fit). */
  selection: string[] | null
  onChange: (selection: string[] | null) => void
}

interface MemoriesSheetProps {
  open: boolean
  onClose: () => void
  /**
   * Opened from a chat rather than Settings: each memory gets a checkbox for
   * whether that chat uses it, instead of the automatic newest-that-fit set.
   */
  selectFor?: MemorySelection
}

/**
 * Everything the model has remembered about you, to read, correct or delete
 * -- so a wrong memory gets fixed instead of repeated in every chat. Opened
 * from a chat (selectFor set), it also picks which memories that chat uses.
 */
export default function MemoriesSheet({ open, onClose, selectFor }: MemoriesSheetProps) {
  const [items, setItems] = useState<Memory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!open) return
    let live = true
    fetch('/api/memories')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const list = await r.json() as Memory[]
        if (live) { setItems(list); setError(null) }
      })
      .catch((err: Error) => { if (live) setError(err.message) })
    return () => { live = false }
  }, [open])

  const save = async (id: string): Promise<void> => {
    const r = await fetch(`/api/memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    })
    const body = await r.json() as Memory & { error?: string }
    if (!r.ok) { toast.error(body.error ?? 'Could not save'); return }
    setItems((list) => list && [body, ...list.filter((m) => m.id !== id)])
    setEditing(null)
  }

  const remove = async (m: Memory): Promise<void> => {
    if (!window.confirm(`Forget this?\n\n${m.text}`)) return
    const r = await fetch(`/api/memories/${encodeURIComponent(m.id)}`, { method: 'DELETE' })
    if (!r.ok) { toast.error('Could not delete'); return }
    setItems((list) => list && list.filter((x) => x.id !== m.id))
    if (selectFor?.selection) selectFor.onChange(selectFor.selection.filter((id) => id !== m.id))
    toast('Forgotten')
  }

  // Automatic (selection === null) behaves, for this checklist, as "every
  // memory currently loads" -- true while everything still fits the prompt
  // budget, which covers most people's actual memory count. Toggling any
  // box switches the chat to that explicit list; nothing is saved otherwise.
  const included = (id: string): boolean => selectFor ? (selectFor.selection ?? items?.map((m) => m.id) ?? []).includes(id) : true
  const toggle = (id: string): void => {
    if (!selectFor || !items) return
    const base = selectFor.selection ?? items.map((m) => m.id)
    selectFor.onChange(base.includes(id) ? base.filter((x) => x !== id) : [...base, id])
  }

  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">{selectFor ? 'Memories for this chat' : 'Memories'}</Drawer.Title>
          {selectFor && (
            <div className="hint memory-select-hint">
              {selectFor.selection
                ? <>Only the checked memories are used here. <button type="button" className="link" onClick={() => selectFor.onChange(null)}>Use the automatic set</button> instead.</>
                : 'Automatic: every memory that fits is used. Uncheck any to switch this chat to a custom set.'}
            </div>
          )}
          <div className="memory-list drawer-scroll" data-vaul-no-drag>
            {error && <div className="hint bad">Couldn&apos;t load memories: {error}</div>}
            {items?.length === 0 && (
              <div className="hint">
                Nothing remembered yet. In a chat with memory on, the model saves what it learns about you here.
              </div>
            )}
            {items?.map((m) => (
              <div key={m.id} className={`memory-row${selectFor ? ' selectable' : ''}`}>
                {selectFor && editing !== m.id && (
                  <label className="memory-check">
                    <input
                      type="checkbox"
                      checked={included(m.id)}
                      onChange={() => toggle(m.id)}
                      aria-label={included(m.id) ? `Used in this chat: ${m.text}` : `Not used in this chat: ${m.text}`}
                    />
                  </label>
                )}
                <div className="memory-body">
                  {editing === m.id ? (
                    <div className="memory-edit">
                      <textarea
                        aria-label="Memory text"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        maxLength={1000}
                      />
                      <div className="row">
                        <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                        <button type="button" className="primary" onClick={() => void save(m.id)} disabled={!draft.trim()}>
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="memory-text">{m.text}</div>
                      <div className="memory-meta">
                        <span>{new Date(m.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span className="spacer" />
                        <button type="button" aria-label={`Edit: ${m.text}`} onClick={() => { setEditing(m.id); setDraft(m.text) }}>
                          <Pencil size={15} aria-hidden="true" />
                        </button>
                        <button type="button" className="danger" aria-label={`Forget: ${m.text}`} onClick={() => void remove(m)}>
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
