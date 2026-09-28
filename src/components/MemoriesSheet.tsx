import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import { Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Memory } from '../types.ts'

interface MemoriesSheetProps {
  open: boolean
  onClose: () => void
}

/**
 * Everything the model has remembered about you, to read, correct or delete
 * -- so a wrong memory gets fixed instead of repeated in every chat.
 */
export default function MemoriesSheet({ open, onClose }: MemoriesSheetProps) {
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
    toast('Forgotten')
  }

  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Memories</Drawer.Title>
          <div className="memory-list drawer-scroll" data-vaul-no-drag>
            {error && <div className="hint bad">Couldn&apos;t load memories: {error}</div>}
            {items?.length === 0 && (
              <div className="hint">
                Nothing remembered yet. In a chat with memory on, the model saves what it learns about you here.
              </div>
            )}
            {items?.map((m) => (
              <div key={m.id} className="memory-row">
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
            ))}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
