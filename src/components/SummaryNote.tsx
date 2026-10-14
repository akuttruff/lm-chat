import { useState, memo } from 'react'
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

export default memo(SummaryNote)
