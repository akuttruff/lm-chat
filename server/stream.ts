import type { ChatEvent, Message, ReplyStats } from '../src/types.ts'

/**
 * A turn's stream: LM Studio's events as they arrive, its closing stats, and
 * the throttle between what the turn produces and what clients and the disk
 * are sent.
 */

/** LM Studio's turn stats, in this app's shape. Null when it sent none. */
export function replyStats(raw: NonNullable<ChatEvent['result']>['stats'], cap: number): ReplyStats | null {
  if (!raw || typeof raw.tokens_per_second !== 'number') return null
  const outputTokens = raw.total_output_tokens ?? 0
  const stats: ReplyStats = {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens,
    reasoningTokens: raw.reasoning_output_tokens ?? 0,
    tokensPerSecond: Math.round(raw.tokens_per_second * 10) / 10,
    firstTokenSeconds: Math.round((raw.time_to_first_token_seconds ?? 0) * 10) / 10,
  }
  if (cap > 0 && outputTokens >= cap) stats.capped = true
  return stats
}

/**
 * While a reply streams, clients get the one conversation that changed at
 * most this often, rather than the whole store on every token.
 */
export const PUBLISH_INTERVAL_MS = 150

/** And the disk copy is refreshed at most this often; the end of a turn always saves. */
export const PERSIST_INTERVAL_MS = 2000

/**
 * Sends a turn's progress to clients and disk: at once on a commit, and
 * coalesced while streaming, so a fast model can't flood either. A commit
 * cancels any pending throttled update, so a stale snapshot can never land
 * after the final state.
 */
export class TailPublisher {
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastPersist = Date.now()

  constructor(
    private readonly save: (messages: Message[], opts: { touch: boolean; persist?: boolean }) => void,
    private readonly send: () => void,
  ) {}

  commit(messages: Message[], { touch = false }: { touch?: boolean } = {}): void {
    this.close()
    this.save(messages, { touch })
    this.lastPersist = Date.now()
    this.send()
  }

  /** Streaming progress: sent within PUBLISH_INTERVAL_MS, saved every PERSIST_INTERVAL_MS. */
  snapshot(current: () => Message[]): void {
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const now = Date.now()
      const persist = now - this.lastPersist >= PERSIST_INTERVAL_MS
      if (persist) this.lastPersist = now
      this.save(current(), { persist, touch: false })
      this.send()
    }, PUBLISH_INTERVAL_MS)
  }

  close(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

/** LM Studio's stream, event by event; `onChunk` on every read, for a watchdog. */
export async function* sseEvents(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<ChatEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    onChunk() // progress: the server is still talking
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '')
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try { yield JSON.parse(payload) as ChatEvent } catch { /* not an event */ }
    }
  }
}
