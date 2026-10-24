import type { Bus } from './bus.ts'
import type { Slots } from './slots.ts'
import type { Store } from './store.ts'
import { deriveName } from './store.ts'
import { cheapestReasoning, manifestCapability, type ReasoningCapability } from './capabilities.ts'
import { describeHttpError, lmStudioFetch } from './lm-studio.ts'
import { historyLimit, planCompaction, planFullCompaction, summarizerInput, summarizerPrompt, summaryTokenCap } from './history.ts'
import { metaOf } from '../src/types.ts'
import { looksLikeChart, parseWheel } from '../src/lib/chartWheel.ts'
import { READINGS_PROMPT, aspectKey, parseReadings, readingsInput, readingsTokenCap } from '../src/lib/readings.ts'
import type { ChatEvent, Message, ServerConfig } from '../src/types.ts'

/**
 * Background model jobs: the requests that follow a reply rather than make
 * it. Each asks the background model (Settings, else the chat model) for a
 * short answer and keeps it on the chat; none of them is ever streamed to a
 * client as it is written.
 */

const SUMMARY_TIMEOUT_MS = 5 * 60 * 1000

/** The reader's recap: two short paragraphs of what the folded conversation covered, in plain words. */
export const RECAP_PROMPT = [
  'Write a recap of a conversation for the person who had it, from the summary below.',
  'One or two short paragraphs, at most 120 words, plain prose, no headings or bullets.',
  'Say what was discussed and what was decided or learned; keep names, numbers and dates.',
  'Address the reader as "you". Reply with the recap only.',
].join(' ')
/** Room for a recap that runs long: the prompt asks for 120 words, the cap only guards against a runaway. */
export const RECAP_MAX_TOKENS = 700

/**
 * A recap that still hit the cap ends mid-sentence; keep whole sentences
 * only. Left alone when it already ends cleanly or when trimming would
 * lose most of it (better a long recap than a one-line one).
 */
export function wholeSentences(text: string): string {
  // Plain prose was asked for; a model that bolds a number anyway would show the asterisks.
  const t = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim()
  if (/[.!?…»”")\]]$/.test(t)) return t
  const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '), t.lastIndexOf('.\n'), t.lastIndexOf('!\n'), t.lastIndexOf('?\n'))
  if (cut < 40) return t
  return t.slice(0, cut + 1).trim()
}

// --- auto-titling -----------------------------------------------------------

export const TITLE_PROMPT = [
  'Write a title for this chat: at most five words, plain words in the language of the conversation,',
  'no quotation marks, no trailing period, no preamble. The chat\'s date is given: when the chat is about',
  'a particular day -- "today", "tomorrow", "this week" -- put that date in the title (e.g. "Forecast for',
  'Sept 30") rather than the relative word, since the title is read long after. Output only the title.',
].join(' ')
/** Room for five words in any script, and a stray sentence if the model ignores the ask. */
export const TITLE_MAX_TOKENS = 24
const TITLE_TIMEOUT_MS = 60 * 1000
/** Per side of the first exchange: enough to know what it's about, not the whole essay. */
const TITLE_EXCERPT = 1200

/** Still carrying the placeholder name (the opening words of the first message), with a reply to title from. */
export function needsTitle(messages: Message[], name: string): boolean {
  const replied = messages.some((m) => m.role === 'assistant' && (m.text || '').trim())
  return replied && name === deriveName(messages)
}

/**
 * The first message and the first reply, clipped, dated -- what the title is
 * written from. The date is the chat's own (when it was started), so "my
 * forecast for today" can become "Forecast for Sept 30" instead of a
 * "Today's..." that means nothing a week later.
 */
export function titleInput(messages: Message[], createdAt: number): string {
  const user = messages.find((m) => m.role === 'user' && (m.text || '').trim())
  const reply = messages.find((m) => m.role === 'assistant' && (m.text || '').trim())
  if (!user || !reply) return ''
  const clip = (t: string): string => (t.length > TITLE_EXCERPT ? `${t.slice(0, TITLE_EXCERPT)}...` : t)
  const date = new Date(createdAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  return `Chat date: ${date}\n\nUser: ${clip((user.text || '').trim())}\n\nAssistant: ${clip((reply.text || '').trim())}`
}

/**
 * The model's answer as a title: first line only, quotes and a trailing
 * period dropped, whitespace collapsed, and never longer than a chat row
 * can show. '' when there's nothing usable.
 */
export function cleanTitle(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  const title = line
    .replace(/^(title:)\s*/i, '')
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return title.length > 60 ? `${title.slice(0, 60).trimEnd()}...` : title
}

/** The whole wheel's readings in one answer: a slow model with a dozen aspects needs a while. */
const READINGS_TIMEOUT_MS = 3 * 60 * 1000

/** A tool message holding a transit chart with no readings yet (or any such chart, when rewriting). */
function wantsReadings(m: Message, force: boolean): boolean {
  return m.role === 'tool' && !m.failed && !!m.output && m.output.includes('"natal"') && looksLikeChart(m.output) && (force || !m.readings)
}

/** What the background jobs need from the Engine that runs them. */
export interface BackgroundHost {
  store: Store
  bus: Bus
  slots: Slots
  /** How to learn what a model accepts; the Engine's, so tests stub it once. */
  capabilities: (config: ServerConfig) => Promise<ReasoningCapability | null>
  /** Send clients a thread's messages from `base` on. */
  publishTail: (conversationId: string, base: number) => void
}

/**
 * One background request, the shape every job here shares: wait for a slot
 * no one is waiting for, ask the background model at its cheapest reasoning
 * level, and return the reply's text. Throws on any failure; each job
 * catches and logs, since they are all best effort.
 */
async function backgroundCompletion(
  host: BackgroundHost,
  config: ServerConfig,
  { systemPrompt, input, maxOutputTokens, timeoutMs }: { systemPrompt: string; input: string; maxOutputTokens: number; timeoutMs: number },
): Promise<string> {
  // Summaries only take a slot no one is waiting for.
  let releaseSlot: (() => void) | undefined
  try {
    releaseSlot = await host.slots.acquire('background')
    // A model of its own, if Settings names one: summarizing is the job
    // for a small fast model, leaving the chat model to the chats.
    const model = config.backgroundModel.trim() || config.model
    const body: Record<string, unknown> = {
      model, system_prompt: systemPrompt, input, stream: true, max_output_tokens: maxOutputTokens,
    }
    const reasoning = cheapestReasoning((await host.capabilities({ ...config, model })) ?? manifestCapability(model))
    if (reasoning) body.reasoning = reasoning
    const res = await lmStudioFetch(config, '/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok || !res.body) throw new Error(await describeHttpError(res))
    return await collectMessage(res.body)
  } finally {
    releaseSlot?.()
  }
}

/**
 * The work that follows a reply: summaries, titles, recaps and transit
 * readings, each a one-off request to the background model. The in-flight
 * sets belong to the EngineState, so they survive a dev-server restart.
 */
export class BackgroundJobs {
  constructor(
    private host: BackgroundHost,
    private compacting: Set<string>,
    private titling: Set<string>,
    private reading: Set<string>,
  ) {}

  /** How many are running right now. */
  count(): number {
    return this.compacting.size + this.titling.size + this.reading.size
  }

  /**
   * A one-off backfill: readings for every transit chart drawn before
   * readings existed, chat by chat in the background. Returns at once with
   * how many charts it will try; each chart's readings arrive as a `tail`.
   */
  readingsAll({ all = false }: { all?: boolean } = {}): { candidates: number } {
    const candidates = this.host.store.getConversations().items
      .filter((c) => !c.temporary)
      .flatMap((c) => c.messages.filter((m) => wantsReadings(m, all)).map((m) => [c.id, m.id] as const))
    if (candidates.length) {
      void (async () => {
        for (const [conversationId, messageId] of candidates) await this.readings(conversationId, messageId, { force: all })
      })()
    }
    return { candidates: candidates.length }
  }

  /** Readings for every transit chart in a chat that has none yet, one after another. */
  async readingsFor(conversationId: string): Promise<void> {
    const conv = this.host.store.get(conversationId)
    if (!conv || conv.temporary) return
    for (const m of conv.messages.filter((x) => wantsReadings(x, false))) await this.readings(conversationId, m.id)
  }

  /**
   * After a transit chart lands: one short reading per aspect on its wheel,
   * written by the model and kept on the tool message, for the popup over
   * each aspect. One request covers the whole wheel. Best effort, like a
   * title: a failure leaves the popup with its positions alone.
   */
  async readings(conversationId: string, messageId: string | number, { force = false }: { force?: boolean } = {}): Promise<Record<string, string> | null> {
    const { store } = this.host
    const key = `${conversationId}/${messageId}`
    if (this.reading.has(key)) return null
    const conv = store.get(conversationId)
    const config = store.getConfig()
    const message = conv?.messages.find((m) => m.id === messageId)
    if (!conv || conv.temporary || !message || !wantsReadings(message, force) || !config.model) return null
    const wheel = parseWheel(message.output ?? '')
    const input = wheel && readingsInput(wheel)
    if (!wheel || !input) return null

    this.reading.add(key)
    try {
      const answer = await backgroundCompletion(this.host, config, {
        systemPrompt: READINGS_PROMPT, input, maxOutputTokens: readingsTokenCap(wheel.aspects.length), timeoutMs: READINGS_TIMEOUT_MS,
      })
      const readings = parseReadings(answer, wheel.aspects.map(aspectKey))
      if (!readings) throw new Error('no readings in the answer')

      // The chat may have moved on while we waited: find the message again.
      const current = store.get(conversationId)
      const index = current?.messages.findIndex((m) => m.id === messageId) ?? -1
      if (!current || index < 0) return null
      const messages = current.messages.map((m, i) => (i === index ? { ...m, readings } : m))
      store.setMessages(conversationId, messages, { touch: false, from: index })
      this.host.publishTail(conversationId, index)
      console.log(`[engine] readings written for ${Object.keys(readings).length} of ${wheel.aspects.length} aspects`)
      return readings
    } catch (err) {
      console.log(`[engine] readings skipped: ${(err as Error).message}`)
      return null
    } finally {
      this.reading.delete(key)
    }
  }

  /**
   * A one-off backfill: a recap for every chat that has a summary but no
   * recap yet (compacted before recaps existed). One at a time in the
   * background; each lands as a patch event. Returns how many it will try.
   */
  recapAll({ all = false }: { all?: boolean } = {}): { candidates: number } {
    const candidates = this.host.store.getConversations().items
      .filter((c) => c.summary?.text && (all || !c.recap) && !c.temporary)
      .map((c) => c.id)
    if (this.host.store.getConfig().model && candidates.length) {
      void (async () => {
        for (const id of candidates) await this.recap(id)
      })()
    }
    return { candidates: candidates.length }
  }

  /**
   * Title every chat still on its placeholder name -- the ones from before
   * titles were written, or whose titling failed -- one at a time in the
   * background, so a backlog never crowds out a reply. Returns at once with
   * how many it will try; each title arrives as a `patch` event.
   */
  retitleAll(): { candidates: number } {
    const config = this.host.store.getConfig()
    const candidates = this.host.store.getConversations().items
      .filter((c) => !c.temporary && needsTitle(c.messages, c.name))
    if (config.model && candidates.length) {
      void (async () => {
        for (const c of candidates) await this.title(c.id, { manual: true })
      })()
    }
    return { candidates: candidates.length }
  }

  /**
   * Give a chat a title written from its first exchange, in place of the
   * opening words of the first message it was named after. Runs once, after
   * the first reply, and only while the chat still has that placeholder
   * name -- so a title the user typed, or one already written, is never
   * replaced. Best effort, like compaction: a failure leaves the placeholder.
   */
  async title(conversationId: string, { manual = false }: { manual?: boolean } = {}): Promise<boolean> {
    const { store, bus } = this.host
    if (this.titling.has(conversationId)) return false
    const conv = store.get(conversationId)
    const config = store.getConfig()
    // Asked for by hand, it runs even with automatic naming switched off.
    if (!conv || (!manual && config.autoTitle === 'off') || conv.temporary || !config.model) return false
    if (!needsTitle(conv.messages, conv.name)) return false
    const input = titleInput(conv.messages, conv.createdAt)
    if (!input) return false

    this.titling.add(conversationId)
    try {
      const name = cleanTitle(await backgroundCompletion(this.host, config, {
        systemPrompt: TITLE_PROMPT, input, maxOutputTokens: TITLE_MAX_TOKENS, timeoutMs: TITLE_TIMEOUT_MS,
      }))
      if (!name) throw new Error('empty title')

      // Renamed, cleared or deleted while we waited: leave it be.
      const current = store.get(conversationId)
      if (!current || !needsTitle(current.messages, current.name)) return false
      const updated = store.patch(conversationId, { name }, { touch: false })
      if (updated) bus.send({ type: 'patch', payload: { conversationId, meta: metaOf(updated) } })
      return true
    } catch (err) {
      console.log(`[engine] titling skipped: ${(err as Error).message}`)
      return false
    } finally {
      this.titling.delete(conversationId)
    }
  }

  /**
   * After /compact: a short recap of what the fold covers, written for the
   * reader from the model's own summary, and kept on the chat. Best effort.
   */
  async recap(conversationId: string): Promise<string | null> {
    const { store, bus } = this.host
    const conv = store.get(conversationId)
    const config = store.getConfig()
    if (!conv?.summary?.text || !config.model) return null
    try {
      const text = wholeSentences(await backgroundCompletion(this.host, config, {
        systemPrompt: RECAP_PROMPT, input: conv.summary.text, maxOutputTokens: RECAP_MAX_TOKENS, timeoutMs: SUMMARY_TIMEOUT_MS,
      }))
      if (!text) throw new Error('empty recap')
      const updated = store.patch(conversationId, { recap: text }, { touch: false })
      if (updated) bus.send({ type: 'patch', payload: { conversationId, meta: metaOf(updated) } })
      return text
    } catch (err) {
      console.log(`[engine] recap skipped: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Fold older turns into the conversation's summary if the replayed context
   * has outgrown the budget. Best effort: on any failure the thread keeps its
   * previous summary and buildHistoryPrompt's trimming covers the gap.
   */
  async compact(conversationId: string, { force = false }: { force?: boolean } = {}): Promise<boolean> {
    const { store, bus } = this.host
    if (this.compacting.has(conversationId)) return false
    const conv = store.get(conversationId)
    if (!conv) return false
    const config = store.getConfig()
    const limit = historyLimit(config.historyChars)
    // Asked for (the /compact command): fold everything so far, budget or not.
    const plan = force ? planFullCompaction(conv.messages, conv.summary) : planCompaction(conv.messages, conv.summary, limit)
    if (!plan || !config.model) return false

    this.compacting.add(conversationId)
    try {
      const text = (await backgroundCompletion(this.host, config, {
        systemPrompt: summarizerPrompt(limit), input: summarizerInput(plan), maxOutputTokens: summaryTokenCap(limit), timeoutMs: SUMMARY_TIMEOUT_MS,
      })).trim()
      if (!text) throw new Error('empty summary')

      // The thread may have moved on (or been cleared) while we summarized;
      // only anchor to a message that is still there.
      const current = store.get(conversationId)
      if (!current?.messages.some((m) => m.id === plan.through)) return false
      const updated = store.patch(conversationId, { summary: { text, through: plan.through } }, { touch: false })
      // So open clients can show where the summary now begins.
      if (updated) bus.send({ type: 'patch', payload: { conversationId, meta: metaOf(updated) } })
      console.log(
        `[engine] compacted ${plan.fold.length} messages into a ${text.length}-char summary`,
      )
      return true
    } catch (err) {
      console.log(`[engine] compaction skipped: ${(err as Error).message}`)
      return false
    } finally {
      this.compacting.delete(conversationId)
    }
  }
}

/** Read an /api/v1/chat stream and return just the reply text, reasoning excluded. */
async function collectMessage(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      let evt: ChatEvent
      try { evt = JSON.parse(line.slice(5).trim()) as ChatEvent } catch { continue }
      if (evt.type === 'message.delta') text += evt.content || ''
      if (evt.type === 'error') throw new Error(evt.error?.message || 'LM Studio reported an error')
    }
  }
  return text
}
