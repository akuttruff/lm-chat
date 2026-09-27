import { useState, memo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronRight, FoldVertical } from 'lucide-react'

interface SummaryNoteProps {
  text: string
}

/**
 * Marks where auto-compaction drew its line: everything above is sent to the
 * model only as this summary. Collapsed by default; open it to check what the
 * model still remembers.
 */
function SummaryNote({ text }: SummaryNoteProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="msg summary-note">
      <button
        type="button"
        className="reasoning-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <FoldVertical size={14} aria-hidden="true" />
        <span>Earlier turns summarized for the model</span>
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

export default memo(SummaryNote)
