import { Suspense, lazy, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Download, Share, X } from 'lucide-react'
import { toast } from 'sonner'
import CopyButton from './CopyButton'
import { downloadText, fenceFile } from '../lib/export'

const MarkdownText = lazy(() => import('./MarkdownText'))

/** The reply's file name when saved: after its first heading, else the chat's name. */
function fileFor(text: string, title: string): { name: string; type: string } {
  const f = fenceFile('markdown', text)
  if (f && f.name !== 'snippet.md') return f
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return { name: `${slug || 'reply'}.md`, type: 'text/markdown' }
}

/** The system share sheet, with the reply as a Markdown file where the browser allows, else as text. */
async function share(text: string, title: string, file: { name: string; type: string }): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  try {
    const asFile = { files: [new File([text], file.name, { type: file.type })], title }
    if (nav.canShare?.(asFile)) await nav.share(asFile)
    else await nav.share({ title, text })
  } catch (err) {
    if ((err as Error).name !== 'AbortError') toast.error("Couldn't share this reply.")
  }
}

/**
 * One reply, full screen, as a document: a reading column with room to
 * breathe, the chat's name as its title, and the ways to take it with you
 * along the top. Escape, the close button or a tap outside returns to the
 * thread. On a wide screen it sits as a panel over the thread.
 */
export default function ReaderView({ text, title, onClose }: { text: string; title: string; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const file = fileFor(text, title)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    // Focus the panel so Escape and scrolling go to it, not the composer.
    panel.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="reader-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="reader" role="dialog" aria-modal="true" aria-label={`Reading: ${title}`} tabIndex={-1} ref={panel}>
        <div className="reader-bar">
          <button type="button" className="icon-btn" aria-label="Close reading view" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
          <div className="reader-title">{title}</div>
          <div className="reader-tools">
            <CopyButton text={text} label="Copy reply" />
            <button type="button" className="copy-btn" aria-label={`Save reply as ${file.name}`} title={`Save as ${file.name}`} onClick={() => downloadText(file.name, text, file.type)}>
              <Download size={15} aria-hidden="true" />
            </button>
            {canShare && (
              <button type="button" className="copy-btn" aria-label="Share reply" title="Share" onClick={() => void share(text, title, file)}>
                <Share size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
        <div className="reader-scroll">
          <article className="md reader-body">
            <Suspense fallback={text}>
              <MarkdownText text={text} />
            </Suspense>
          </article>
        </div>
      </div>
    </div>,
    document.body,
  )
}
