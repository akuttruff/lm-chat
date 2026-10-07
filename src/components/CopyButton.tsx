import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

/** Copies `text` to the clipboard; the icon turns into a tick for a moment to say so. */
export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return undefined
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setDone(true)
    } catch {
      toast.error("Couldn't copy. Select the text and copy it instead.")
    }
  }
  return (
    <button type="button" className={`copy-btn${done ? ' done' : ''}`} aria-label={done ? 'Copied' : label} title={label} onClick={() => void copy()}>
      {done ? <Check size={15} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  )
}
