import {useState, memo} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Brain, ChevronRight } from 'lucide-react'

interface ReasoningBlockProps {
  text?: string
  streaming?: boolean
  elapsed?: string
}

/** The model's chain of thought, collapsed by default like LM Studio's. */
function ReasoningBlock({ text, streaming, elapsed }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="msg reasoning">
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Brain size={14} aria-hidden="true" />
        <span>
          {streaming ? 'Thinking...' : `Thought${elapsed ? ` for ${elapsed}s` : ''}`}
        </span>
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
          <ChevronRight size={14} aria-hidden="true" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="reasoning-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            <div className="reasoning-text">{text}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(ReasoningBlock)
