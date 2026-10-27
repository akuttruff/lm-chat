import { useState, type ReactNode } from 'react'
import { ChevronDown, Download, ExternalLink, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { CONVERTED, canOpen, openFile, saveFile, type FenceFile } from '../lib/export'
import CopyButton from './CopyButton'

const SOURCE_NAMES: Record<string, string> = { markdown: 'Markdown', html: 'HTML', svg: 'SVG', csv: 'CSV', tsv: 'TSV' }

/** "PDF · from Markdown", "HTML · 84 lines": what the card holds, at a glance. */
function describe(file: FenceFile, text: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
  if (file.convert) return `${CONVERTED[ext]?.label ?? ext.toUpperCase()} · made from ${SOURCE_NAMES[file.convert]}`
  const lines = text.replace(/\n$/, '').split('\n').length
  return `${ext.toUpperCase() || 'File'} · ${lines} ${lines === 1 ? 'line' : 'lines'}`
}

/**
 * A file the model wrote (a fence with a file name): shown as the file,
 * with its text folded away, rather than as a wall of code. Save it, open
 * it in a tab when a browser can show it, copy its text, or unfold it to
 * read. A PDF, Word document or spreadsheet is made on the server when
 * it's saved or opened.
 */
export default function FileCard({ file, text, children }: { file: FenceFile; text: string; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState<'save' | 'open' | null>(null)

  const act = async (kind: 'save' | 'open'): Promise<void> => {
    if (busy) return
    setBusy(kind)
    try {
      await (kind === 'save' ? saveFile(file, text) : openFile(file, text))
    } catch (err) {
      toast.error((err as Error).message || `Couldn't make ${file.name}.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="file-card">
      <div className="file-head">
        <FileText size={18} aria-hidden="true" className="file-icon" />
        <div className="file-title">
          <span className="file-name">{file.name}</span>
          <span className="file-meta">{describe(file, text)}</span>
        </div>
        <div className="file-actions">
          <button type="button" className="code-save" aria-label={`Save ${file.name}`} title={`Save ${file.name}`} disabled={!!busy} onClick={() => void act('save')}>
            {busy === 'save' ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Download size={13} aria-hidden="true" />} Save
          </button>
          {canOpen(file) && (
            <button type="button" className="copy-btn" aria-label={`Open ${file.name}`} title={`Open ${file.name} in a new tab`} disabled={!!busy} onClick={() => void act('open')}>
              {busy === 'open' ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <ExternalLink size={14} aria-hidden="true" />}
            </button>
          )}
          <CopyButton text={text} label={`Copy the text of ${file.name}`} />
          <button type="button" className={`copy-btn file-fold${shown ? ' open' : ''}`} aria-expanded={shown} aria-label={shown ? 'Hide the text' : 'Show the text'} title={shown ? 'Hide the text' : 'Show the text'} onClick={() => setShown((s) => !s)}>
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {shown && <pre>{children}</pre>}
    </div>
  )
}
