import { Suspense, lazy, memo } from 'react'
import type { MessageImage, MessageRole, ReplyStats } from '../types.ts'
import SpeakButton from './SpeakButton'

const MarkdownText = lazy(() => import('./MarkdownText'))

interface MessageBubbleProps {
  /** The message's id: with it, a finished reply gets a button to read it aloud. */
  id?: string
  role: MessageRole
  text?: string
  /** User messages: the images sent with the text. */
  images?: MessageImage[]
  model?: string
  /** The specific LM Studio instance that answered, preferred over `model`. */
  instance?: string
  elapsed?: string
  streaming?: boolean
  stats?: ReplyStats
}

/** 9003 reads better as 9.0K in a footer; small counts stay exact. */
const compact = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}K` : String(n))

/**
 * The cost of a reply, in LM Studio's own numbers: generation speed, what
 * went in and came out, and how long the first token took. That last one is
 * the number to watch -- it's prompt reading plus any wait in the queue,
 * the part of a slow reply that isn't the model writing.
 */
function statsLine(s: ReplyStats): string {
  const thinking = s.reasoningTokens > 0 ? ` (${compact(s.reasoningTokens)} thinking)` : ''
  return `${s.tokensPerSecond} tok/s · ${compact(s.inputTokens)} in / ${compact(s.outputTokens)} out${thinking}` +
    ` · ${s.firstTokenSeconds}s to first token`
}

function MessageBubble({
  id, role, text, images, model, instance, elapsed, streaming, stats,
}: MessageBubbleProps) {
  const isError = role === 'error'
  const wrapClass = `msg ${isError ? 'error' : role}`

  return (
    <div className={wrapClass}>
      {images && images.length > 0 && (
        // Above the words, as they were attached; tap one for the full size.
        <div className="bubble-images">
          {images.map((img) => (
            <a key={img.id} href={`/api/images/${img.id}`} target="_blank" rel="noreferrer" title={img.name}>
              <img src={`/api/images/${img.id}`} alt={img.name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {(text || role !== 'user') && (
      <div className="bubble">
        {role === 'assistant' && !streaming ? (
          <div className="md">
            {/* The words are readable at once; formatting follows a moment later. */}
            <Suspense fallback={text}>
              <MarkdownText text={text ?? ''} />
            </Suspense>
          </div>
        ) : (
          // Plain text while tokens arrive. Re-parsing the markdown of a
          // long reply on every token is quadratic in its length, and it is
          // what made a large conversation stutter. Half-written markdown
          // renders badly anyway -- unclosed fences, partial tables -- so
          // formatting once the reply settles also looks better.
          text
        )}
        {streaming && <span className="cursor" />}
      </div>
      )}
      {role === 'assistant' && !streaming && (model || (id && text)) && (
        <div className="msg-foot">
          {id && text && <SpeakButton id={id} text={text} />}
          {model && (
            <div className="meta">
              {instance || model} &middot; {elapsed}s
              {stats && <span className="meta-stats"> &middot; {statsLine(stats)}</span>}
              {stats?.capped && <span className="meta-capped"> &middot; cut off at the reply length cap</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(MessageBubble)
