import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowDown, MessagesSquare, Pencil, RotateCcw } from 'lucide-react'
import MessageBubble from './MessageBubble'
import ToolCard from './ToolCard'
import ReasoningBlock from './ReasoningBlock'
import SummaryNote from './SummaryNote'
import { speaker } from './SpeakButton'
import { computeInitialScrollState, findAnchor, saveScrollAnchor } from '../lib/scrollMemory.ts'
import type { ContextSummary, Message } from '../types.ts'

interface ChatThreadProps {
  messages: Message[]
  /** Shown after the last message it covers, if that message is still here. */
  summary?: ContextSummary | null
  /**
   * Whose reading position to remember. Threads are remounted per
   * conversation (see App.tsx's `key`), so nothing else survives a switch --
   * this is what lets returning to a long thread put you back where you were.
   * Omit in tests that don't care; every real conversation has a distinct one.
   */
  conversationId?: string
  /** Re-run the last message you sent. Absent while a reply is in flight. */
  onRetry?: () => void
  /**
   * Send a changed version of a message you sent. The conversation carries
   * on from there in a new chat; this one keeps the original and its reply.
   */
  onEdit?: (messageId: string, text: string) => Promise<void> | void
  /** Scroll to this message and mark it for a moment: a search hit being opened. */
  focusMessageId?: string | null
}

/** What a row needs to offer editing: a way to start, and the editor's own two actions once started. */
interface EditControls {
  start: () => void
  editing: boolean
  submit: (text: string) => void
  cancel: () => void
}

/**
 * Your message, open for editing in place: the text as sent, to change and
 * send again. Sending starts a new branch of the chat from this point.
 */
function MessageEditor({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`
  }, [])
  const changed = text.trim() !== initial.trim() && text.trim().length > 0
  return (
    <div className="msg user editing">
      <textarea
        ref={ref}
        className="edit-input"
        value={text}
        aria-label="Edit your message"
        onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px` }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && changed) onSubmit(text.trim())
        }}
      />
      <div className="edit-actions">
        <span className="edit-note">Sends in a new branch of this chat; this one keeps the original.</span>
        <button type="button" className="link-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="edit-send" onClick={() => onSubmit(text.trim())} disabled={!changed}>Send as new branch</button>
      </div>
    </div>
  )
}

/**
 * How close to the bottom still counts as "following". A few pixels of slack
 * absorbs sub-pixel rounding and the last line growing as tokens arrive.
 */
const NEAR_BOTTOM_PX = 80

/**
 * Messages drawn when a thread opens. A long thread -- a hundred messages of
 * markdown and tool output -- took long enough to render that opening it
 * stalled the phone; the rest are a tap away.
 */
export const INITIAL_WINDOW = 40

/**
 * One message, memoised.
 *
 * A streamed reply changes only the final message, but every row used to
 * re-render on every token -- re-parsing the markdown of the whole thread
 * each time. On a long conversation that was tens of milliseconds per token,
 * which is what made scrolling stutter.
 */
/** The fields a row actually renders. */
function sameMessage(a: Message, b: Message): boolean {
  return a.id === b.id
    && a.role === b.role
    && a.text === b.text
    && a.output === b.output
    && a.name === b.name
    && a.plugin === b.plugin
    // Parameters arrive once, mid-call; compared by content, as the object is new on every push.
    && (a.args === b.args || JSON.stringify(a.args) === JSON.stringify(b.args))
    && a.failed === b.failed
    && a.streaming === b.streaming
    && a.model === b.model
    && a.instance === b.instance
    && a.elapsed === b.elapsed
    // Set once, at the end of a turn; its object is new on every push, so
    // compare what it says rather than which object says it.
    && a.stats?.tokensPerSecond === b.stats?.tokensPerSecond
    && a.stats?.outputTokens === b.stats?.outputTokens
}

const ThreadRow = memo(function ThreadRow({ message, onRetry, edit }: { message: Message; onRetry?: () => void; edit?: EditControls }) {
  return (
    <motion.div
      className={`msg-row ${message.role}`}
      data-msg-id={message.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {message.role === 'tool' ? (
        <ToolCard
          name={message.name}
          plugin={message.plugin}
          args={message.args}
          output={message.output}
          failed={message.failed}
        />
      ) : message.role === 'reasoning' ? (
        <ReasoningBlock
          text={message.text}
          streaming={message.streaming}
          elapsed={message.elapsed}
        />
      ) : edit?.editing ? (
        <MessageEditor initial={message.text ?? ''} onSubmit={edit.submit} onCancel={edit.cancel} />
      ) : (
        <>
          {edit && (
            <button type="button" className="retry-btn edit-btn" aria-label="Edit this message" title="Edit and send as a new branch" onClick={edit.start}>
              <Pencil size={14} aria-hidden="true" />
            </button>
          )}
          {onRetry && (
            <button type="button" className="retry-btn" aria-label="Retry this message" title="Retry" onClick={onRetry}>
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          )}
        <MessageBubble
          id={String(message.id)}
          role={message.role}
          text={message.text}
          images={message.images}
          model={message.model}
          instance={message.instance}
          elapsed={message.elapsed}
          streaming={message.streaming}
          stats={message.stats}
        />
        </>
      )}
    </motion.div>
  )
}, (prev, next) => sameMessage(prev.message, next.message) && Boolean(prev.onRetry) === Boolean(next.onRetry)
  && Boolean(prev.edit) === Boolean(next.edit) && prev.edit?.editing === next.edit?.editing)
// Compared field by field, not by reference: the server pushes the whole
// conversation on every token, so every message object is new even when
// nothing about it changed.

/** How long a scroll must sit still before the reading position is saved. */
const SAVE_SCROLL_DELAY_MS = 400

export default function ChatThread({ messages, summary, conversationId = 'default', onRetry, onEdit, focusMessageId }: ChatThreadProps) {
  // The message open for editing, if any: one at a time.
  const [editingId, setEditingId] = useState<string | null>(null)
  const editFor = (msg: Message): EditControls | undefined => {
    if (!onEdit || msg.role !== 'user') return undefined
    const id = String(msg.id)
    return {
      start: () => setEditingId(id),
      editing: editingId === id,
      submit: (text) => { setEditingId(null); void onEdit(id, text) },
      cancel: () => setEditingId(null),
    }
  }
  // Only the last message you sent can be retried: what came after it is what gets replaced.
  let lastUserId: Message['id'] | undefined
  if (onRetry) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') { lastUserId = messages[i]!.id; break }
    }
  }
  // Each chat has its own thread (remounted per chat), so leaving one stops its voice.
  useEffect(() => () => speaker.stop(), [])
  const threadRef = useRef<HTMLDivElement>(null)
  // Read once on mount: where a previous visit to this conversation left
  // off, if it left off somewhere other than the bottom. `restore` is
  // consumed by the layout effect below and then never used again --
  // ongoing scroll behaviour is entirely the following/handleScroll pair.
  const [initial] = useState(() => computeInitialScrollState(conversationId, messages, INITIAL_WINDOW))
  const restoreTo = useRef(initial.restore)
  // Whether new content should pull the view down. Reading back through a
  // conversation while the model is still writing used to be impossible:
  // every token yanked the scroll to the bottom again.
  const [following, setFollowing] = useState(initial.following)
  const [shown, setShown] = useState(initial.shown)
  const hidden = Math.max(0, messages.length - shown)
  const visible = hidden ? messages.slice(hidden) : messages
  // Showing earlier messages adds height above what you're reading; keep
  // the view where it was instead of letting it jump.
  const heightBefore = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = threadRef.current
    if (!el || heightBefore.current == null) return
    el.scrollTop += el.scrollHeight - heightBefore.current
    heightBefore.current = null
  }, [shown])
  const showEarlier = (): void => {
    heightBefore.current = threadRef.current?.scrollHeight ?? null
    setShown((n) => n + INITIAL_WINDOW * 2)
  }

  // A search hit: bring the message into view, revealing earlier history if
  // it's beyond what's drawn, and mark it for a moment.
  useEffect(() => {
    if (!focusMessageId) return undefined
    const index = messages.findIndex((m) => String(m.id) === focusMessageId)
    if (index === -1) return undefined
    if (index < hidden) { setShown(messages.length - index + 1); return undefined }
    const row = threadRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(focusMessageId)}"]`)
    if (!row) return undefined
    row.scrollIntoView({ block: 'center' })
    row.classList.add('found')
    const t = setTimeout(() => row.classList.remove('found'), 2000)
    return () => clearTimeout(t)
  }, [focusMessageId, hidden, messages])

  // Once, after the first commit -- which already shows enough of the
  // thread's history to contain the target, per computeInitialScrollState.
  useLayoutEffect(() => {
    const el = threadRef.current
    const target = restoreTo.current
    if (!el || !target) return
    restoreTo.current = null
    for (const row of el.querySelectorAll<HTMLElement>('[data-msg-id]')) {
      if (row.dataset.msgId === String(target.anchorId)) {
        el.scrollTop = row.offsetTop + target.offset
        break
      }
    }
  }, [])

  const lastMessage = messages.at(-1)
  const lastId = lastMessage?.id
  const lastRole = lastMessage?.role

  // Guards the effect below against firing on mount: a thread whose last
  // message happens to be from the user (a question still awaiting a
  // reply) must not override a just-restored reading position.
  const mountedForOwnMessage = useRef(false)
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    if (!mountedForOwnMessage.current) { mountedForOwnMessage.current = true; return }
    // Sending a message is a request to see it, wherever you were reading.
    if (lastRole === 'user') {
      setFollowing(true)
      el.scrollTop = el.scrollHeight
    }
  }, [lastId, lastRole])

  useEffect(() => {
    const el = threadRef.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [messages, following])

  // Only ever reads live DOM/ref state, never React state -- so it stays
  // correct however stale the closure that happens to hold it, which lets it
  // double as both the scroll handler's own debounce and an unmount/hide
  // flush registered once and never recreated.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flushScrollSave = useCallback((): void => {
    clearTimeout(saveTimer.current)
    const el = threadRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    saveScrollAnchor(conversationId, distanceFromBottom <= NEAR_BOTTOM_PX ? null : findAnchor(el))
  }, [conversationId])

  // Covers leaving the thread by switching conversations (unmount) and by
  // backgrounding or closing the app (visibilitychange fires for both, and
  // reliably on a phone where beforeunload does not).
  //
  // A layout effect, not a plain one: on unmount, React detaches threadRef
  // before a passive effect's cleanup would run, so flushScrollSave would
  // find nothing to read from. A layout effect's cleanup runs first, while
  // the ref is still attached.
  useLayoutEffect(() => {
    const onHide = (): void => { if (document.hidden) flushScrollSave() }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      flushScrollSave()
    }
  }, [flushScrollSave])

  const handleScroll = (): void => {
    const el = threadRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const followingNow = distanceFromBottom <= NEAR_BOTTOM_PX
    setFollowing(followingNow)
    clearTimeout(saveTimer.current)
    if (followingNow) {
      // Caught up: next time, just show the bottom rather than an old spot.
      saveScrollAnchor(conversationId, null)
    } else {
      saveTimer.current = setTimeout(flushScrollSave, SAVE_SCROLL_DELAY_MS)
    }
  }

  const jumpToLatest = (): void => {
    const el = threadRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setFollowing(true)
  }

  if (messages.length === 0) {
    return (
      <div className="thread" ref={threadRef}>
        <div className="empty">
          <MessagesSquare size={28} aria-hidden="true" />
          Point this at your Mac&apos;s LM Studio server and start chatting from anywhere on your network.
        </div>
      </div>
    )
  }

  return (
    <div className="thread-wrap">
      <div className="thread" ref={threadRef} onScroll={handleScroll}>
        {hidden > 0 && (
          <button type="button" className="show-earlier" onClick={showEarlier}>
            Show {Math.min(hidden, INITIAL_WINDOW * 2)} earlier message{hidden === 1 ? '' : 's'}
          </button>
        )}
        <AnimatePresence initial={false}>
          {visible.flatMap((msg) => {
            const row = <ThreadRow key={msg.id} message={msg} onRetry={msg.id === lastUserId ? onRetry : undefined} edit={editFor(msg)} />
            if (!summary?.text || msg.id !== summary.through) return [row]
            return [row, (
              <motion.div
                key="summary"
                className="msg-row summary"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.18 }}
              >
                <SummaryNote text={summary.text} />
              </motion.div>
            )]
          })}
        </AnimatePresence>
      </div>

      {!following && (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          <ArrowDown size={15} aria-hidden="true" />
          Jump to latest
        </button>
      )}
    </div>
  )
}
