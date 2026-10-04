import { useState, useRef, useCallback, useEffect } from 'react'
import { ArrowUp, Brain, Folder, Gauge, Ghost, ImagePlus, ListChecks, Square, Wrench, X } from 'lucide-react'
import { toast } from 'sonner'
import { ACCEPTED, hasImage, imageFiles, prepareImage } from '../lib/images'
import type { ImageUpload } from '../types.ts'

interface ComposerProps {
  onSend: (text: string, images?: ImageUpload[]) => void
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

/** As many as the server takes per message (see api.ts). */
const MAX_ATTACHMENTS = 6

export default function Composer({
  onSend, disabled, busy, onStop, reasoningLabel, onOpenReasoning, temporaryOn = false, onToggleTemporary,
  memoryOn = false, onToggleMemory, onPickMemories, folderLabel, onOpenFolderPicker, onOpenTools, toolsCustomized = false,
}: ComposerProps) {
  const [text, setText] = useState('')
  // Images waiting to go with the next message: picked, pasted or dropped,
  // already scaled down (see prepareImage), shown as thumbnails until sent.
  const [images, setImages] = useState<ImageUpload[]>([])
  const [preparing, setPreparing] = useState(false)
  // An image is being dragged over the window: the composer lights up as the target.
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`
    }
  }, [])

  const attach = useCallback(async (files: File[]): Promise<void> => {
    if (!files.length) return
    setPreparing(true)
    try {
      const room = MAX_ATTACHMENTS - images.length
      if (files.length > room) toast.error(`Up to ${MAX_ATTACHMENTS} images per message`)
      const ready: ImageUpload[] = []
      for (const f of files.slice(0, Math.max(room, 0))) {
        try {
          ready.push(await prepareImage(f))
        } catch (err) {
          toast.error((err as Error).message)
        }
      }
      if (ready.length) setImages((prev) => [...prev, ...ready])
    } finally {
      setPreparing(false)
    }
  }, [images.length])

  // Drop anywhere in the window: a screenshot dragged from the desktop
  // shouldn't have to land on the message box exactly. Without
  // preventDefault on dragover the browser refuses the drop (and would
  // open the image as a page instead); dragleave to outside the window
  // (relatedTarget null) clears the highlight.
  useEffect(() => {
    if (disabled) return
    const over = (e: DragEvent): void => {
      if (!hasImage(e.dataTransfer?.items)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const leave = (e: DragEvent): void => { if (e.relatedTarget == null) setDragging(false) }
    const drop = (e: DragEvent): void => {
      const files = imageFiles(e.dataTransfer?.items)
      setDragging(false)
      if (!files.length) return
      e.preventDefault()
      void attach(files)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [attach, disabled])

  const handleSubmit = (e: React.FormEvent | React.KeyboardEvent) => {
    e.preventDefault()
    const trimmed = text.trim()
    if ((!trimmed && !images.length) || disabled || preparing) return
    onSend(trimmed, images.length ? images : undefined)
    setText('')
    setImages([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  // A screenshot pasted from the clipboard is the common case on a Mac;
  // text pastes go through untouched.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData?.items)
    if (!files.length) return
    e.preventDefault()
    void attach(files)
  }

  const canSend = !disabled && !preparing && (text.trim().length > 0 || images.length > 0)

  return (
    <form className={`composer${dragging ? ' dragging' : ''}`} onSubmit={handleSubmit}>
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
      <div className="composer-attachments" aria-label="Images to send">
        {images.map((img, i) => (
          <div key={`${img.name}-${i}`} className="attachment">
            <img src={img.dataUrl} alt={img.name} />
            <button
              type="button"
              className="remove"
              aria-label={`Remove ${img.name}`}
              onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <div className="composer-row">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED.join(',')}
          multiple
          hidden
          aria-label="Choose images"
          onChange={(e) => { void attach(Array.from(e.target.files ?? [])); e.target.value = '' }}
        />
        <button
          type="button"
          className="attach-btn"
          aria-label="Add an image"
          title="Add an image (or paste one)"
          disabled={disabled || preparing || images.length >= MAX_ATTACHMENTS}
          onClick={() => fileRef.current?.click()}
        >
          <ImagePlus size={18} aria-hidden="true" />
        </button>
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          placeholder={images.length ? 'Say something about the image, or just send' : 'Message'}
          autoComplete="off"
          value={text}
          onChange={(e) => { setText(e.target.value); autoGrow() }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
            disabled={!canSend}
            aria-label="Send"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </form>
  )
}
