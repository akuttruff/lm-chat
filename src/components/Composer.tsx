import { useState, useRef, useCallback } from 'react'
import { ArrowUp, Brain, Folder, Gauge, Ghost, ListChecks, Square, Wrench } from 'lucide-react'

interface ComposerProps {
  onSend: (text: string) => void
  disabled?: boolean
  busy?: boolean
  onStop?: () => void
  reasoningLabel?: string
  onOpenReasoning?: () => void
  /** Nothing about this chat is saved while on. */
  temporaryOn?: boolean
  onToggleTemporary?: () => void
  /** Whether this chat uses memory; the chip toggles it. */
  memoryOn?: boolean
  onToggleMemory?: () => void
  /** Pick which saved memories this chat uses, instead of the automatic set. Shown only while memory is on. */
  onPickMemories?: () => void
  /** This chat's folder, or "Folder" when it isn't in one. */
  folderLabel?: string
  onOpenFolderPicker?: () => void
  /** Pick which tools this chat offers the model; `toolsCustomized` when it has a list of its own. */
  onOpenTools?: () => void
  toolsCustomized?: boolean
}

export default function Composer({
  onSend, disabled, busy, onStop, reasoningLabel, onOpenReasoning, temporaryOn = false, onToggleTemporary,
  memoryOn = false, onToggleMemory, onPickMemories, folderLabel, onOpenFolderPicker, onOpenTools, toolsCustomized = false,
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
      {/* The chips get a row of their own, above the message box: five of
          them beside it left a phone a sliver to type in. */}
      <div className="composer-chips">
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
      {onToggleTemporary && (
        <button
          type="button"
          className={`reasoning-chip temporary-chip${temporaryOn ? ' on' : ''}`}
          onClick={onToggleTemporary}
          aria-pressed={temporaryOn}
          aria-label={temporaryOn ? 'Temporary chat -- nothing is being saved' : 'Save this chat normally -- tap to make it temporary'}
          title={temporaryOn ? 'Temporary -- nothing is being saved. Tap to save normally.' : 'Tap to make this chat temporary: nothing will be saved.'}
        >
          {/* Filled when on, outline when off -- same cue as the memory chip. */}
          <Ghost size={14} aria-hidden="true" fill={temporaryOn ? 'currentColor' : 'none'} />
        </button>
      )}
      {onOpenFolderPicker && (
        <button
          type="button"
          className="reasoning-chip folder-chip"
          onClick={onOpenFolderPicker}
          aria-label={`Folder: ${folderLabel}`}
        >
          <Folder size={14} aria-hidden="true" />
          <span>{folderLabel}</span>
        </button>
      )}
      {onOpenTools && (
        <button
          type="button"
          className={`reasoning-chip tools-chip${toolsCustomized ? ' on' : ''}`}
          onClick={onOpenTools}
          aria-label={toolsCustomized ? 'Tools: chosen for this chat' : 'Tools: same as the folder or Settings'}
          title={toolsCustomized ? 'This chat has its own tool list' : 'Choose which tools this chat offers the model'}
        >
          <Wrench size={14} aria-hidden="true" />
          <span>Tools</span>
        </button>
      )}
      {onToggleMemory && (
        <button
          type="button"
          className={`reasoning-chip memory-chip${memoryOn ? ' on' : ''}`}
          onClick={onToggleMemory}
          aria-pressed={memoryOn}
          aria-label={memoryOn ? 'Memory on for this chat' : 'Memory off for this chat'}
          title={memoryOn ? 'Memory on -- tap to turn off for this chat' : 'Memory off -- tap to turn on for this chat'}
        >
          {/* Filled when on, outline when off -- a second cue alongside color,
              so on/off doesn't come down to spotting a shade of green. */}
          <Brain size={14} aria-hidden="true" fill={memoryOn ? 'currentColor' : 'none'} />
        </button>
      )}
      {memoryOn && onPickMemories && (
        <button
          type="button"
          className="reasoning-chip memory-picker-chip"
          onClick={onPickMemories}
          aria-label="Choose which memories this chat uses"
          title="Choose which memories this chat uses"
        >
          <ListChecks size={14} aria-hidden="true" />
        </button>
      )}
      </div>
      <div className="composer-row">
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
      </div>
    </form>
  )
}
