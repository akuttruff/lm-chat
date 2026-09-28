import { Suspense, lazy, memo } from 'react'
import type { MessageRole } from '../types.ts'

const MarkdownText = lazy(() => import('./MarkdownText'))

interface MessageBubbleProps {
  role: MessageRole
  text?: string
  model?: string
  /** The specific LM Studio instance that answered, preferred over `model`. */
  instance?: string
  elapsed?: string
  streaming?: boolean
}

function MessageBubble({
  role, text, model, instance, elapsed, streaming,
}: MessageBubbleProps) {
  const isError = role === 'error'
  const wrapClass = `msg ${isError ? 'error' : role}`

  return (
    <div className={wrapClass}>
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
      {role === 'assistant' && !streaming && model && (
        <div className="meta">{instance || model} &middot; {elapsed}s</div>
      )}
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(MessageBubble)
