import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Download } from 'lucide-react'
import { downloadText, fenceFile } from '../lib/export'
import CopyButton from './CopyButton'

/**
 * Split into its own chunk (see MessageBubble): the markdown parser is a
 * large share of the app's JavaScript, and nothing needs it until a finished
 * reply is on screen -- the app shell can paint first.
 */
export default function MarkdownText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock }}>{text}</Markdown>
}

/** A fenced block's language tag, file-name meta and text, read from the hast node react-markdown hands a custom <pre>. */
interface HastNode { type?: string; tagName?: string; value?: string; properties?: { className?: unknown }; data?: { meta?: string | null }; children?: HastNode[] }
function fenceOf(node: HastNode | undefined): { info: string | undefined; code: string } | null {
  const code = node?.children?.find((c) => c.tagName === 'code')
  if (!code) return null
  const classes = Array.isArray(code.properties?.className) ? code.properties.className.map(String) : []
  const lang = classes.map((c) => /^language-(.+)$/.exec(c)?.[1]).find(Boolean)
  // ```markdown meal-plan.md -- the words after the language land in meta.
  const meta = code.data?.meta ?? undefined
  const text = (code.children ?? []).map((c) => c.value ?? '').join('')
  return { info: [lang, meta].filter(Boolean).join(' ') || undefined, code: text }
}

/**
 * A fenced block with its tools in the corner: copy its text, and -- when
 * its language has a file form (a Markdown block as .md, a CSV as .csv) --
 * save it as a file. The way to get a file out of a reply: ask for the
 * content in a fence.
 */
function CodeBlock({ children, node }: { children?: ReactNode; node?: HastNode }) {
  const fence = fenceOf(node)
  if (!fence) return <pre>{children}</pre>
  const file = fenceFile(fence.info, fence.code)
  return (
    <div className="code-block">
      <pre>{children}</pre>
      <div className="code-tools">
        <CopyButton text={fence.code} label={file ? `Copy ${file.name}` : 'Copy code'} />
        {file && (
          <button
            type="button"
            className="code-save"
            aria-label={`Save as ${file.name}`}
            title={`Save as ${file.name}`}
            onClick={() => downloadText(file.name, fence.code, file.type)}
          >
            <Download size={13} aria-hidden="true" /> {file.name}
          </button>
        )}
      </div>
    </div>
  )
}
