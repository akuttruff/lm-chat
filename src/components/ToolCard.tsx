import {useState, memo} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Wrench, ChevronRight, TriangleAlert } from 'lucide-react'

interface ToolCardProps {
  name?: string
  /** The MCP server that provided the tool, e.g. "mcp/astrology-v2". */
  plugin?: string
  output?: string
  failed?: boolean
}

function ToolCard({ name, plugin, output, failed }: ToolCardProps) {
  const [open, setOpen] = useState(false)
  const long = (output || '').length > 120
  const preview = long ? `${(output ?? '').slice(0, 120).trimEnd()}...` : output

  return (
    <div className="msg tool">
      <div className={`tool-card${failed ? ' failed' : ''}`}>
        <button
          type="button"
          className="tool-head"
          onClick={() => long && setOpen((v) => !v)}
          aria-expanded={long ? open : undefined}
          disabled={!long}
        >
          {failed
            ? <TriangleAlert size={14} aria-hidden="true" />
            : <Wrench size={14} aria-hidden="true" />}
          <span className="tc-name">
            {name ?? 'tool'}
            {plugin && <span className="tc-plugin">{plugin}</span>}
          </span>
          {long && (
            <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
              <ChevronRight size={14} aria-hidden="true" />
            </motion.span>
          )}
        </button>
        {output && (
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={open ? 'full' : 'preview'}
              className="out"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.12 }}
            >
              {open ? output : preview}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(ToolCard)
