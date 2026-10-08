import { Download } from 'lucide-react'
import { downloadText, fenceFile } from '../lib/export'

/**
 * Saves a reply as a Markdown file -- for when the model wrote the document
 * as its answer rather than inside a fence. Named after the reply's first
 * heading, or "reply.md".
 */
export default function SaveButton({ text }: { text: string }) {
  const file = fenceFile('markdown', text) ?? { name: 'reply.md', type: 'text/markdown' }
  const name = file.name === 'snippet.md' ? 'reply.md' : file.name
  const label = `Save reply as ${name}`
  return (
    <button type="button" className="copy-btn" aria-label={label} title={label} onClick={() => downloadText(name, text, file.type)}>
      <Download size={14} aria-hidden="true" />
    </button>
  )
}
