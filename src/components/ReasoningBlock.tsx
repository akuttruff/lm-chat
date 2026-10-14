import {useState, memo} from 'react'
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
        <span className="chev">
          <ChevronRight size={14} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className="reasoning-body">
          <div className="reasoning-text">{text}</div>
        </div>
      )}
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(ReasoningBlock)
