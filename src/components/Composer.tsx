import { useState, useRef, useCallback } from 'react'
import { ArrowUp, Gauge, Square } from 'lucide-react'

interface ComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  busy?: boolean
  onStop?: () => void
  reasoningLabel?: string
  onOpenReasoning?: () => void
}

export default function Composer({
  onSend, disabled, busy, onStop, reasoningLabel, onOpenReasoning,
}: ComposerProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    }
  }, [])

  const handleSubmit = (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      {onOpenReasoning && (
        <button
          type="button"
          className="reasoning-chip"
          onClick={onOpenReasoning}
          aria-label={`Reasoning effort: ${reasoningLabel}`}
        >
          <Gauge size={14} aria-hidden="true" />
          <span>{reasoningLabel}</span>
        </button>
      )}
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={1}
        placeholder="Message"
        autoComplete="off"
        value={text}
        onChange={(e) => { setText(e.target.value); autoGrow() }}
        onKeyDown={handleKeyDown}
      />
      {busy && onStop ? (
        <button
          type="button"
          className="send-btn stop"
          onClick={onStop}
          aria-label="Stop generating"
        >
          <Square size={15} aria-hidden="true" />
        </button>
      ) : (
        <button
          type="submit"
          className="send-btn"
          disabled={disabled || !text.trim()}
          aria-label="Send"
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      )}
    </form>
  )
}
