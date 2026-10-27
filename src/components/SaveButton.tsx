import { useEffect, useRef, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { REPLY_FORMATS, replyFile, saveFile } from '../lib/export'

/**
 * Saves a whole reply as a file -- for when the model wrote the document
 * as its answer rather than inside a fence. A menu of formats: Markdown as
 * it is, or a PDF, Word document or web page made from it on the server.
 * Named after the reply's first heading, or "reply".
 */
/** `below`: the menu opens downward, for a button at the top of the screen. */
export default function SaveButton({ text, below = false }: { text: string; below?: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const away = (e: PointerEvent): void => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    // Escape closes the menu only, not the reading view it may sit in.
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key) }
  }, [open])

  const save = async (ext: string): Promise<void> => {
    setOpen(false)
    setBusy(true)
    const file = replyFile(text, ext)
    try {
      await saveFile(file, text)
    } catch (err) {
      toast.error((err as Error).message || `Couldn't make ${file.name}.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="save-wrap" ref={ref}>
      <button type="button" className="copy-btn" aria-label="Save reply as a file" title="Save reply as a file" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((v) => !v)}>
        {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
      </button>
      {open && (
        <div className={`more-menu save-menu${below ? ' below' : ''}`} role="menu" aria-label="Save reply as">
          {REPLY_FORMATS.map((f) => (
            <button key={f.ext} type="button" role="menuitem" onClick={() => void save(f.ext)}>
              {f.label} <span className="save-ext">{replyFile(text, f.ext).name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
