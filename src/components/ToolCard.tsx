import { useMemo, useState, memo } from 'react'
import { motion } from 'motion/react'
import { Wrench, ChevronRight, TriangleAlert } from 'lucide-react'
import { prettyOutput, sizeLabel, toolLabel } from '../lib/toolFormat.ts'

interface ToolCardProps {
  name?: string
  /** The MCP server that provided the tool, e.g. "mcp/astrology-v2". */
  plugin?: string
  output?: string
  failed?: boolean
}

/** Output this short is shown whole; anything longer collapses to one line. */
const SHORT = 120

/**
 * One tool call. Collapsed, it's a single row -- what ran, from where, how
 * much it returned -- with one line of the result; expanded, the whole
 * result in its own scrolling panel, JSON indented.
 */
function ToolCard({ name, plugin, output, failed }: ToolCardProps) {
  const [open, setOpen] = useState(false)
  const text = output ?? ''
  const short = text.length > 0 && text.length <= SHORT
  const expandable = text.length > SHORT
  // Only format what's being shown: results run to tens of kilobytes.
  const full = useMemo(() => (open ? prettyOutput(text) : ''), [open, text])
  const source = plugin?.replace(/^mcp\//, '')
  const meta = [source, text.length > SHORT ? sizeLabel(text.length) : null, failed ? 'failed' : null]
    .filter(Boolean).join(' · ')

  return (
    <div className="msg tool">
      <div className={`tool-card${failed ? ' failed' : ''}${open ? ' open' : ''}`}>
        <button
          type="button"
          className="tool-head"
          onClick={() => expandable && setOpen((v) => !v)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          title={name}
        >
          <span className="tc-icon" aria-hidden="true">
            {failed ? <TriangleAlert size={14} /> : <Wrench size={14} />}
          </span>
          <span className="tc-title">
            <span className="tc-name">{toolLabel(name)}</span>
            {meta && <span className="tc-meta">{meta}</span>}
          </span>
          {expandable && (
            <motion.span className="tc-chevron" animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
              <ChevronRight size={16} aria-hidden="true" />
            </motion.span>
          )}
        </button>
        {short && <div className="tc-short">{text}</div>}
        {expandable && !open && <div className="tc-preview">{text.replace(/\s+/g, ' ').slice(0, 300)}</div>}
        {expandable && open && <pre className="tc-output">{full}</pre>}
      </div>
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(ToolCard)
