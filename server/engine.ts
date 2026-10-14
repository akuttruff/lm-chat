import type { Bus } from './bus.ts'
import type { Store } from './store.ts'
import { deriveName, newId } from './store.ts'
import { readModelConfig } from './model-config.ts'
import { canTurnOff, cheapestReasoning, fitReasoning, reasoningCapability } from './capabilities.ts'
import type { ReasoningCapability } from './capabilities.ts'
import { Slots, parallelLimit } from './slots.ts'
import { AUTO_LOADED, MEMORY_PLUGIN, Memories } from './memory.ts'
import { Transcript, formatToolOutput, toolArgs, type ReplyMeta } from './transcript.ts'
import { metaOf } from '../src/types.ts'
export { formatToolOutput, toolArgs }
import { parseIntegrations } from '../src/lib/integrations.ts'
import { looksLikeChart, parseWheel } from '../src/lib/chartWheel.ts'
import { READINGS_PROMPT, aspectKey, parseReadings, readingsInput, readingsTokenCap } from '../src/lib/readings.ts'
import type { ChatEvent, ContextSummary, Conversation, Folder, ImageUpload, Message, MessageImage, ReplyStats, ServerConfig } from '../src/types.ts'

/**
 * Runs a turn against LM Studio, server-side.
 *
 * The browser used to do this. That meant a locked screen, a backgrounded tab
 * or a reload killed the generation outright -- LM Studio would log "Client
 * disconnected" and throw the work away. Here the turn outlives any client.
 */

/**
 * Replay the conversation to the model as a system prompt.
 *
 * /api/v1/chat cannot accept a role-tagged history -- `input` is a single
 * turn -- so LM Studio's own `previous_response_id` is the only alternative.
 * That handle is a single point of failure: one dropped turn produces no
 * `chat.end`, no id, and the thread silently loses its entire memory. Sending
 * the transcript every turn costs tokens and buys immunity from that, which
 * is the right trade against a local model.
 */
export function buildHistoryPrompt(
  systemPrompt: string,
  history: Message[],
  limit: number,
  summary?: ContextSummary | null,
): string | undefined {
  const { rest, summary: digest } = splitAtSummary(history.slice(0, -1), summary)
  const lines = rest.filter(replayable).map((m) => transcriptLine(m))
  if (!lines.length && !digest) return systemPrompt.trim() || undefined

  // Keep the most recent turns when trimming: recency matters most, and the
  // model's own context window is finite however many tokens we can spend.
  // Normally compaction keeps us under the limit and this never fires; it is
  // the fallback for when a summary couldn't be made. Whole messages are
  // dropped, so the model never sees one cut off mid-sentence.
  let trimmed = false
  if (limit > 0) {
    const budget = Math.max(limit - (digest?.text.length ?? 0), Math.floor(limit / 3))
    let size = lines.reduce((n, l) => n + l.length + 2, 0)
    while (lines.length > 1 && size > budget) {
      size -= lines.shift()!.length + 2
      trimmed = true
    }
    if (lines.length === 1 && lines[0]!.length > budget) {
      lines[0] = lines[0]!.slice(-budget)
      trimmed = true
    }
  }

  return [
    systemPrompt.trim(),
    digest ? `Summary of the earlier conversation:\n\n${digest.text.trim()}` : '',
    lines.length ? 'The conversation so far, for context:' : '',
    trimmed ? '...' : '',
    lines.join('\n\n'),
  ].filter(Boolean).join('\n\n')
}

function replayable(m: Message): boolean {
  if (m.role === 'user' || m.role === 'assistant') return Boolean((m.text || '').trim())
  // Tool results are context, not noise: a follow-up question usually
  // refers to the data a tool fetched.
  // (Not the card showing which memories were loaded: they are in the system prompt.)
  if (m.role === 'tool') return m.plugin !== AUTO_LOADED && Boolean((m.output || '').trim())
  return false
}

function transcriptLine(m: Message, maxOutput = Infinity): string {
  // An image is only sent on the turn it arrived with; later turns see that
  // it was there, by name, where the text would be.
  if (m.role === 'user') return `User: ${[...(m.images ?? []).map((i) => `[image: ${i.name}]`), (m.text || '').trim()].filter(Boolean).join(' ')}`
  if (m.role === 'assistant') return `Assistant: ${(m.text || '').trim()}`
  const label = m.failed ? `Tool ${m.name ?? 'tool'} failed` : `Tool ${m.name ?? 'tool'} returned`
  const output = (m.output || '').trim()
  return `${label}: ${output.length > maxOutput ? `${output.slice(0, maxOutput)}...` : output}`
}

/**
 * The messages a summary doesn't already cover. A summary whose anchor
 * message is gone (a thread edited or restored from backup) no longer
 * describes this history, so it is ignored rather than trusted.
 */
function splitAtSummary(
  messages: Message[],
  summary: ContextSummary | null | undefined,
): { rest: Message[]; summary: ContextSummary | null } {
  if (!summary?.text.trim()) return { rest: messages, summary: null }
  const i = messages.findIndex((m) => m.id === summary.through)
  if (i === -1) return { rest: messages, summary: null }
  return { rest: messages.slice(i + 1), summary }
}

/**
 * Auto-compaction.
 *
 * Replaying the transcript every turn is robust, but once it outgrew the
 * budget the old tail-trim moved the start of the prompt on every turn, so
 * LM Studio could never reuse its prompt cache and re-read everything. Now,
 * when the replayed context passes the budget, the older turns are folded
 * into a model-written summary and only the newest third stays verbatim.
 * Between compactions the prompt only ever grows at the end, which keeps the
 * cached prefix valid; the cache is invalidated once per compaction instead
 * of once per turn.
 */
export const COMPACT_KEEP_RATIO = 1 / 3
export const SUMMARY_RATIO = 1 / 6
/** Per tool result, in the summarizer's input only; the thread keeps them whole. */
const SUMMARY_TOOL_OUTPUT = 6000
const SUMMARY_TIMEOUT_MS = 5 * 60 * 1000

export interface CompactionPlan {
  /** Messages to fold into the summary, oldest first. */
  fold: Message[]
  /** The last folded message: the new summary's anchor. */
  through: string | number
  previous: ContextSummary | null
}

/**
 * Decide whether a thread needs compacting, and what to fold. Returns null
 * while the replayed context still fits.
 */
export function planCompaction(
  history: Message[],
  summary: ContextSummary | null | undefined,
  limit: number,
): CompactionPlan | null {
  if (!(limit > 0)) return null
  const { rest, summary: previous } = splitAtSummary(history, summary)
  const size = (ms: Message[]): number =>
    ms.filter(replayable).reduce((n, m) => n + transcriptLine(m).length + 2, 0)
  if ((previous?.text.length ?? 0) + size(rest) <= limit) return null

  // Walk back from the newest message, keeping whole messages up to the
  // verbatim share, then back up to a user turn so an exchange isn't split.
  const keepBudget = Math.floor(limit * COMPACT_KEEP_RATIO)
  let split = rest.length
  let kept = 0
  while (split > 0) {
    const m = rest[split - 1]!
    const add = replayable(m) ? transcriptLine(m).length + 2 : 0
    if (kept + add > keepBudget && kept > 0) break
    kept += add
    split--
  }
  while (split < rest.length && rest[split]!.role !== 'user') split++
  // Always leave the latest exchange verbatim.
  const lastUser = rest.map((m) => m.role).lastIndexOf('user')
  if (lastUser !== -1) split = Math.min(split, lastUser)

  const fold = rest.slice(0, split)
  if (!fold.some(replayable)) return null
  return { fold, through: fold[fold.length - 1]!.id, previous }
}

/**
 * Fold everything so far -- every message the previous summary does not
 * already cover -- on request (the /compact command), whatever the budget.
 * Null when there is nothing replayable to fold.
 */
export function planFullCompaction(history: Message[], summary: ContextSummary | null | undefined): CompactionPlan | null {
  const { rest, summary: previous } = splitAtSummary(history, summary)
  if (!rest.some(replayable)) return null
  return { fold: rest, through: rest[rest.length - 1]!.id, previous }
}

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

export function summarizerPrompt(limit: number): string {
  const words = Math.max(80, Math.round((limit * SUMMARY_RATIO) / 6))
  return [
    'You compress chat history so another model can continue the conversation',
    'without seeing the original. Merge the previous summary (if any) with the new',
    `turns into a single summary of at most ${words} words.`,
    'Keep: facts the user stated about themselves, names, dates, numbers, decisions,',
    'preferences, unresolved questions, and the specific data tools returned (exact',
    'values, not "the tool returned data"). Drop greetings, filler and repetition.',
    'Write terse bullet points in the third person. Output only the summary.',
  ].join(' ')
}

/**
 * Most characters the summarizer is handed. A thread whose fold is a
 * dozen big tool results otherwise makes an 80K-token summarizing request
 * that sits at "reading prompt" for minutes -- on a model that then writes
 * a few hundred words. Tool outputs are clipped harder first, since they're
 * where the bulk is; only if that isn't enough are the oldest turns left
 * out (any earlier summary still covers what came before them).
 */
export const MAX_SUMMARY_INPUT = 20000

export function summarizerInput(plan: CompactionPlan, cap = MAX_SUMMARY_INPUT): string {
  const previous = plan.previous ? `Previous summary:\n\n${plan.previous.text.trim()}` : ''
  const budget = Math.max(cap - previous.length, Math.floor(cap / 2))
  const folded = plan.fold.filter(replayable)
  const build = (perTool: number): string[] => folded.map((m) => transcriptLine(m, perTool))
  const size = (lines: string[]): number => lines.reduce((n, l) => n + l.length + 2, 0)

  let perTool = SUMMARY_TOOL_OUTPUT
  let lines = build(perTool)
  while (size(lines) > budget && perTool > 500) {
    perTool = Math.floor(perTool / 2)
    lines = build(perTool)
  }
  let dropped = 0
  while (lines.length > 1 && size(lines) > budget) {
    lines.shift()
    dropped++
  }
  return [
    previous,
    'New turns to fold in:',
    dropped ? `(${dropped} older ${dropped === 1 ? 'turn was' : 'turns were'} too long to include and left out.)` : '',
    lines.join('\n\n'),
  ].filter(Boolean).join('\n\n')
}

/**
 * An output cap for the summarizer: roughly twice the words it was asked
 * for, in tokens, plus slack. It stops a model that ignores the word limit
 * from writing for half an hour.
 */
export function summaryTokenCap(limit: number): number {
  const words = Math.max(80, Math.round((limit * SUMMARY_RATIO) / 6))
  return words * 2 + 200
}

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

/** A Settings number field: blank, junk or 0 means "no cap". */
export function outputCap(raw: string): number {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// --- the date, in every message ---------------------------------------------

/**
 * The message as sent to the model: your text, then a line saying when it
 * was sent. The model has no clock, and "what's my forecast for today" or
 * "how many days until Friday" needs one; a tool call for it costs a whole
 * extra round trip (prompt re-read and all), every time. Stamped on the
 * message -- the part of the prompt that is new anyway -- it costs nothing
 * and leaves LM Studio's cached prefix alone, where a line at the top of
 * the system prompt would invalidate it every turn. The saved message is
 * never changed; only what's sent.
 */
/**
 * Tells the model what the stamp is, so it reads as "now" and not as a
 * footer to ignore: in tests the model worked that out unprompted, but a
 * stated rule is cheaper than a lucky inference, and it covers filling
 * date parameters for tools too.
 */
export const DATE_NOTE =
  'Each message from the user ends with a [Sent ...] line: the date and time it was sent. That is the current ' +
  "date and time -- treat it as 'now' for anything time-relative (today, tomorrow, this week, how long until) " +
  'and when filling date parameters for tools.'

export function stampInput(text: string, now: Date = new Date()): string {
  const when = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
  return text ? `${text}\n\n[Sent ${when}]` : `[Sent ${when}]`
}

/**
 * Decode an upload from the browser. The browser sends a base64 data URL
 * (what a canvas gives it); the data dir wants bytes. Checked here rather
 * than trusted: the API accepts the shape, this is what makes it an image.
 */
export function decodeUpload(u: ImageUpload): { name: string; mime: string; bytes: Buffer } {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(u.dataUrl)
  if (!m) throw new Error('an image must be a base64 data URL')
  if (m[1]!.toLowerCase() !== u.mime) throw new Error('an image\'s type must match its data')
  return { name: u.name, mime: u.mime, bytes: Buffer.from(m[2]!, 'base64') }
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

/** Reasoning options from the model's manifest, for when LM Studio can't be asked. */
function manifestCapability(model: string): ReasoningCapability | null {
  const cfg = readModelConfig(model)
  if ('error' in cfg || !cfg.reasoning) return null
  const allowed = cfg.reasoning.options.map((o) => o.value)
  // Otherwise a chosen 'off' would be dropped and the model would think at its default.
  if (canTurnOff(cfg, null) && !allowed.includes('off')) allowed.push('off')
  return { allowed, default: cfg.reasoning.default }
}

export { parseIntegrations }

async function describeHttpError(res: Response): Promise<string> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } })?.error?.message || ''
    } catch {
      detail = text.slice(0, 200)
    }
  } catch { /* body already consumed or absent */ }
  if (res.status === 401 || res.status === 403) {
    return detail || 'LM Studio rejected the API token. Check it in Settings.'
  }
  if (res.status === 404) {
    return detail || 'Endpoint not found. /api/v1/chat needs LM Studio 0.4.0 or newer.'
  }
  return detail || `LM Studio returned HTTP ${res.status}.`
}

/**
 * While a reply streams, clients get the one conversation that changed at
 * most this often, rather than the whole store on every token.
 */
export const PUBLISH_INTERVAL_MS = 150

/** And the disk copy is refreshed at most this often; the end of a turn always saves. */
export const PERSIST_INTERVAL_MS = 2000

interface TurnState {
  controller: AbortController
  stalled: boolean
}

/**
 * Sends a turn's progress to clients and disk: at once on a commit, and
 * coalesced while streaming, so a fast model can't flood either. A commit
 * cancels any pending throttled update, so a stale snapshot can never land
 * after the final state.
 */
class TailPublisher {
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
async function* sseEvents(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator<ChatEvent> {
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

function lastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return i
  return -1
}

/**
 * Which turns and compactions are in flight. Held apart from the Engine so a
 * dev-server restart, which builds a new Engine from fresh code, still knows
 * about requests the old one started -- otherwise the "already in flight"
 * guard resets and a retry queues a duplicate behind the original.
 */
export interface EngineState {
  running: Map<string, TurnState>
  compacting: Set<string>
  /** Chats a title is being written for right now. */
  titling?: Set<string>
  /** Tool messages (by id) whose transit readings are being written right now. */
  reading?: Set<string>
  /** The latest in-progress status per chat, for clients that connect mid-reply. */
  statuses: Map<string, StatusPayload>
  /** Created by the first Engine, which knows where the limit is configured. */
  slots?: Slots
}

export interface StatusPayload {
  conversationId: string
  state: string
  text: string
  startedAt: number | null
}

export function newEngineState(): EngineState {
  return { running: new Map(), compacting: new Set(), statuses: new Map() }
}

export class Engine {
  private running: Map<string, TurnState>
  private compacting: Set<string>
  private titling: Set<string>
  private reading: Set<string>
  private statuses: Map<string, StatusPayload>
  /** Each thread's messages as last sent in a tail, one JSON print per message, so the next tail can skip what has not changed. */
  private sent = new Map<string, string[]>()
  readonly slots: Slots

  constructor(
    private store: Store,
    private bus: Bus,
    /** How to learn what a model accepts; injectable so tests needn't stub LM Studio twice. */
    private capabilities: (config: ServerConfig) => Promise<ReasoningCapability | null> = reasoningCapability,
    state: EngineState = newEngineState(),
    /** The shared memory pool, read into the prompt for chats with memory on. */
    private memories: Memories = new Memories(),
  ) {
    this.running = state.running
    this.compacting = state.compacting
    // ??= : state kept from before a code change may predate a field.
    this.titling = state.titling ??= new Set()
    this.reading = state.reading ??= new Set()
    this.statuses = state.statuses ??= new Map()
    this.slots = state.slots ??= new Slots(() => parallelLimit(this.store.getConfig().parallel))
  }

  /** Every chat currently waiting on or receiving a reply. */
  activeStatuses(): StatusPayload[] {
    return [...this.statuses.values()]
  }

  isRunning(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  stop(conversationId: string): boolean {
    const turn = this.running.get(conversationId)
    if (!turn) return false
    turn.controller.abort(new DOMException('stopped', 'AbortError'))
    return true
  }

  private publish(conversationId: string, state: string, text: string, startedAt: number | null): void {
    const payload = { conversationId, state, text, startedAt }
    if (state === 'pending') this.statuses.set(conversationId, payload)
    else this.statuses.delete(conversationId)
    this.bus.send({ type: 'status', payload })
  }

  /**
   * Send the part of a thread a turn has changed: its messages from `base`
   * on, less any at the front that clients already hold as they are. While
   * a reply streams, that leaves the reply alone: the prompt, the tool
   * results and the reasoning before it went out once and stay as sent, and
   * resending a chart's output several times a second over the tunnel was
   * most of what a phone downloaded during a turn.
   */
  private publishTail(conversationId: string, base: number): void {
    const conv = this.store.get(conversationId)
    if (!conv) return
    const sent = this.sent.get(conversationId) ?? []
    const prints = conv.messages.map((m, i) => (i < base ? sent[i] ?? '' : JSON.stringify(m)))
    let from = base
    while (from < prints.length && from < sent.length && prints[from] === sent[from]) from++
    this.sent.set(conversationId, prints)
    this.bus.send({
      type: 'tail',
      payload: { conversationId, base: from, messages: conv.messages.slice(from), meta: metaOf(conv) },
    })
  }

  /** Generate the reply to the last message you sent again, discarding what followed it. */
  /** The request's `input`: plain text, or text-and-image parts when the message has images. */
  private inputFor(text: string, images: MessageImage[] | undefined): string | Record<string, string>[] {
    const stamped = stampInput(text)
    if (!images?.length) return stamped
    const parts: Record<string, string>[] = [{ type: 'text', content: stamped }]
    for (const img of images) {
      const stored = this.store.readImage(img.id)
      // Gone from disk (a backup restored elsewhere): the name still tells the model something was here.
      if (!stored) { parts[0]!.content = `[image ${img.name} is no longer available]\n\n${stamped}`; continue }
      parts.push({ type: 'image', data_url: `data:${stored.mime};base64,${stored.bytes.toString('base64')}` })
    }
    return parts
  }

  async retryTurn(conversationId: string): Promise<void> {
    const conv = this.store.get(conversationId)
    if (!conv) throw new Error('no such conversation')
    const last = lastUserIndex(conv.messages)
    if (last === -1) throw new Error('nothing to retry')
    return this.runTurn(conversationId, conv.messages[last]!.text ?? '', { retry: true })
  }

  /**
   * Append the user's message and generate a reply. Resolves when the turn
   * finishes; callers may ignore the promise, since progress is published on
   * the bus and persisted as it goes.
   */
  async runTurn(
    conversationId: string,
    text: string,
    { retry = false, images = [], attachments = [] }: { retry?: boolean; images?: ImageUpload[]; attachments?: MessageImage[] } = {},
  ): Promise<void> {
    const conv = this.store.get(conversationId)
    if (!conv) throw new Error('no such conversation')
    if (this.running.has(conversationId)) throw new Error('a reply is already in flight')
    // Decoded before the turn is claimed: a bad upload is this call's error, not a stuck chat.
    const uploads = images.map(decodeUpload)
    // Claimed before the first await, so a second send can't slip in meanwhile.
    const controller = new AbortController()
    const turn: TurnState = { controller, stalled: false }
    this.running.set(conversationId, turn)
    try {
      await this.runClaimed(conversationId, text, { retry, uploads, attachments }, turn)
    } catch (err) {
      // Anything that threw before the turn's own handling took over (a
      // full disk, a locked memory database) must not leave the chat
      // claimed, or every later send is refused as "already in flight".
      if (this.running.get(conversationId) === turn) {
        this.running.delete(conversationId)
        this.publish(conversationId, '', 'failed', null)
      }
      throw err
    }
  }

  private async runClaimed(
    conversationId: string,
    text: string,
    { retry, uploads, attachments }: { retry: boolean; uploads: ReturnType<typeof decodeUpload>[]; attachments: MessageImage[] },
    turn: TurnState,
  ): Promise<void> {
    const conv = this.store.get(conversationId)!
    const { controller } = turn
    const config = this.store.getConfig()
    // The chat's folder, whose defaults sit between the chat's own settings
    // and the global ones.
    const folder = conv.folderId ? this.store.getFolder(conv.folderId) : undefined
    // A retry re-runs the last message you sent: whatever came after it (a
    // failed or unwanted reply, its tool calls) is dropped, and clients are
    // sent everything from that message on, replacing their copy.
    const retryFrom = retry ? lastUserIndex(conv.messages) : -1
    const history = retry ? conv.messages.slice(0, retryFrom + 1) : [...conv.messages]
    // Everything before here stays as it is for the whole turn, so clients
    // are only ever sent what comes after.
    const tailFrom = retry ? retryFrom : history.length
    const base = config.lmStudioUrl.replace(/\/+$/, '')
    const tail = new TailPublisher(
      (messages, opts) => this.store.setMessages(conversationId, messages, { ...opts, from: tailFrom }),
      () => this.publishTail(conversationId, tailFrom),
    )
    const fail = (message: string, statusText: string): void => {
      tail.commit([...history, { id: newId(), role: 'error', text: message }])
      this.publish(conversationId, '', statusText, null)
    }

    if (!retry) {
      const message: Message = { id: newId(), role: 'user', text }
      // Saved first, so the message carries their ids and a retry can re-send them.
      if (uploads.length) message.images = uploads.map((u) => this.store.saveImage(conversationId, u))
      // Images already stored (a branch sending an edited message again, with the original's pictures).
      else if (attachments.length) message.images = attachments
      history.push(message)
    }
    // The message being sent -- on a retry, the one being sent again.
    const sent = history[history.length - 1]!
    // Only sending a message moves a chat up the list; everything after
    // that (the reply, its errors) leaves its place alone.
    tail.commit(history, { touch: true })

    if (!config.model) {
      this.running.delete(conversationId)
      fail('No model selected. Choose one in Settings.', 'no model')
      return
    }

    const startedAt = Date.now()
    const status = (text: string): void => this.publish(conversationId, 'pending', text, startedAt)
    status('thinking...')
    const { body, cap, memory } = await this.requestFor(conv, folder, config, history, text, sent)

    const stallSeconds = Number(config.stallSeconds) || 0
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const armWatchdog = (): void => {
      clearTimeout(watchdog)
      if (!stallSeconds) return
      watchdog = setTimeout(() => {
        turn.stalled = true
        controller.abort(new DOMException('stalled', 'AbortError'))
      }, stallSeconds * 1000)
    }

    const transcript = new Transcript(history)
    transcript.noteMemories(memory?.used ?? [])
    let instance: string | null = null
    let completed = false
    let responseId: string | null = null
    const meta = (): ReplyMeta => ({ model: config.model, instance, elapsed: ((Date.now() - startedAt) / 1000).toFixed(1), responseId })
    const snapshot = (): void => tail.snapshot(() => transcript.visible())
    const finalize = (): void => {
      transcript.finish(meta())
      tail.commit(transcript.visible())
    }
    /** The turn ended early: what it had, then a note saying why. */
    const cutShort = (text: string, statusText: string): void => {
      finalize()
      tail.commit([...transcript.all(), { id: newId(), role: 'error', text }])
      this.publish(conversationId, '', statusText, null)
    }

    let succeeded = false
    let releaseSlot: (() => void) | undefined

    try {
      // Wait here rather than inside LM Studio, where a queued request is
      // silent: the watchdog starts only once the model is really on it.
      if (!this.slots.free('turn')) {
        status('waiting for a free slot...')
        releaseSlot = await this.slots.acquire('turn', controller.signal)
        status('thinking...')
      } else {
        releaseSlot = await this.slots.acquire('turn', controller.signal)
      }
      armWatchdog()

      const res = await fetch(`${base}/api/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        fail(await describeHttpError(res), res.status === 401 ? 'auth failed' : `HTTP ${res.status}`)
        return
      }
      if (!res.body) throw new Error('LM Studio returned no stream')

      for await (const evt of sseEvents(res.body, armWatchdog)) {
        switch (evt.type) {
          case 'chat.start':
            if (evt.model_instance_id) instance = evt.model_instance_id
            break
          case 'model_load.start':
            status('loading model...')
            break
          case 'model_load.progress':
            status(`loading model ${Math.round((evt.progress || 0) * 100)}%`)
            break
          case 'prompt_processing.start':
            status('reading prompt...')
            break
          case 'prompt_processing.progress':
            status(`reading prompt ${Math.round((evt.progress || 0) * 100)}%`)
            break
          case 'reasoning.start':
            status('reasoning...')
            transcript.startReasoning()
            snapshot()
            break
          case 'reasoning.delta':
            transcript.reasoningDelta(evt.content || '')
            snapshot()
            break
          case 'reasoning.end':
            transcript.closeReasoning()
            snapshot()
            break
          case 'message.start':
            status('writing...')
            transcript.closeReasoning()
            break
          case 'message.delta':
            transcript.messageDelta(evt.content || '')
            snapshot()
            break
          case 'message.end':
            transcript.endMessage(meta())
            snapshot()
            break
          case 'tool_call.start':
            transcript.startTool(evt.tool)
            status('calling a tool...')
            snapshot()
            break
          case 'tool_call.name':
          case 'tool_call.arguments': {
            const name = evt.tool_name || evt.tool
            if (!name) break
            transcript.nameTool(name, evt.provider_info?.plugin_id, evt.arguments)
            status(`using ${name}...`)
            snapshot()
            break
          }
          case 'tool_call.success':
            transcript.toolResult(evt)
            snapshot()
            break
          case 'tool_call.failure':
            transcript.toolFailure(evt)
            snapshot()
            break
          case 'error':
            throw new Error(evt.error?.message || 'LM Studio reported an error')
          case 'chat.end':
            completed = true
            if (evt.result?.response_id) {
              responseId = evt.result.response_id
              this.store.patch(conversationId, { responseId }, { touch: false })
            }
            transcript.setStats(replyStats(evt.result?.stats, cap))
            break
          default:
            break
        }
      }

      finalize()
      this.publish(conversationId, 'live', 'connected', null)
      succeeded = true
    } catch (err) {
      if (completed) {
        // The reply arrived in full and the connection dropped afterwards.
        finalize()
        this.publish(conversationId, 'live', 'connected', null)
        succeeded = true
      } else if (turn.stalled) {
        cutShort(
          `No output from LM Studio for ${stallSeconds}s, so the reply was abandoned. It may still be working on a long tool call.`,
          'no response',
        )
      } else if ((err as Error)?.name === 'AbortError') {
        cutShort('Stopped.', 'stopped')
      } else if (transcript.producedAnything()) {
        cutShort(`The reply was cut short: ${(err as Error).message}`, 'interrupted')
      } else {
        fail(
          `Couldn't reach LM Studio at ${base}. Check that its server is running. ` +
          `(${(err as Error).message})`,
          "can't reach LM Studio",
        )
      }
    } finally {
      clearTimeout(watchdog)
      tail.close()
      releaseSlot?.()
      this.running.delete(conversationId)
      this.publishTail(conversationId, tailFrom)
    }

    // After the turn is released, so the user can already send the next one;
    // that turn simply replays a little more until the summary lands.
    if (succeeded) {
      await this.compact(conversationId)
      await this.title(conversationId)
      await this.readingsFor(conversationId)
    }
  }

  /**
   * The request for one turn: the model, the input (with this turn's
   * pictures), the limits, the reasoning level, the tools, and the whole
   * conversation replayed as the system prompt. Settings resolve chat, then
   * folder, then global.
   */
  private async requestFor(
    conv: Conversation,
    folder: Folder | undefined,
    config: ServerConfig,
    history: Message[],
    text: string,
    sent: Message,
  ): Promise<{ body: Record<string, unknown>; cap: number; memory: ReturnType<Memories['context']> | null }> {
    // With images, the input is parts: the text, then each image as a data
    // URL (LM Studio's /api/v1/chat takes {type:'image', data_url}). Only
    // this turn carries them; the transcript names them afterwards.
    const body: Record<string, unknown> = { model: config.model, input: this.inputFor(text, sent.images), stream: true }
    const ctx = Number.parseInt(config.contextLength, 10)
    // Applied at load time: sending it every turn makes LM Studio JIT-load a new
    // model instance per message instead of reusing the loaded one.
    if (Number.isFinite(ctx) && ctx > 0) body.context_length = ctx
    const cap = outputCap(config.maxOutputTokens)
    if (cap) body.max_output_tokens = cap
    // Chat, then folder, then Settings. `||` for the folder and Settings:
    // an unset level is stored as '' and means inherit, not "no reasoning".
    // A chat's saved level may predate a model switch (medium, say, on a
    // model that only takes off|on), which LM Studio rejects outright.
    const requested = conv.reasoning ?? (folder?.reasoning || config.reasoning || null)
    const reasoning = requested
      ? fitReasoning(requested, (await this.capabilities(config)) ?? manifestCapability(config.model))
      : null
    if (reasoning) body.reasoning = reasoning
    // Memory is per chat, then the folder's, then the Settings default; when
    // on, the model gets the memory tools and what it has saved so far. The
    // toggle owns the memory plugin outright: if it's also (still) listed in
    // the general Settings tools field, that must not override "off" for this
    // chat, so it's stripped from there and re-added only when memory is on.
    const memoryOn = conv.memory ?? folder?.memory ?? config.memoryDefault === 'on'
    // Chat, then folder, then Settings. `??` throughout: '' is "no tools",
    // null "same as the level above".
    const integrations = parseIntegrations(conv.tools ?? folder?.mcpTools ?? config.mcpTools)
      .filter((i) => i.id !== MEMORY_PLUGIN)
    if (memoryOn) integrations.push({ type: 'plugin', id: MEMORY_PLUGIN })
    if (integrations.length) body.integrations = integrations
    // Every turn carries its own context, so no turn depends on the last one
    // having succeeded.
    const limit = historyLimit(config.historyChars)
    // Which memories: the chat's own pick, else the folder's, else automatic.
    const memory = memoryOn ? this.memories.context(4000, conv.memorySelection ?? folder?.memorySelection) : null
    // The date note goes first and never changes, so it costs the prompt
    // cache nothing; the stamp it refers to rides on each message (see
    // stampInput).
    const systemPrompt = [DATE_NOTE, config.systemPrompt.trim(), memory?.block].filter(Boolean).join('\n\n')
    const prompt = buildHistoryPrompt(systemPrompt, history, limit, conv.summary)
    if (prompt) body.system_prompt = prompt
    return { body, cap, memory }
  }

  /**
   * A one-off backfill: readings for every transit chart drawn before
   * readings existed, chat by chat in the background. Returns at once with
   * how many charts it will try; each chart's readings arrive as a `tail`.
   */
  readingsAll({ all = false }: { all?: boolean } = {}): { candidates: number } {
    const candidates = this.store.getConversations().items
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
  private async readingsFor(conversationId: string): Promise<void> {
    const conv = this.store.get(conversationId)
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
    const key = `${conversationId}/${messageId}`
    if (this.reading.has(key)) return null
    const conv = this.store.get(conversationId)
    const config = this.store.getConfig()
    const message = conv?.messages.find((m) => m.id === messageId)
    if (!conv || conv.temporary || !message || !wantsReadings(message, force) || !config.model) return null
    const wheel = parseWheel(message.output ?? '')
    const input = wheel && readingsInput(wheel)
    if (!wheel || !input) return null

    this.reading.add(key)
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await this.slots.acquire('background')
      const model = config.backgroundModel.trim() || config.model
      const body: Record<string, unknown> = {
        model, system_prompt: READINGS_PROMPT, input, stream: true, max_output_tokens: readingsTokenCap(wheel.aspects.length),
      }
      const reasoning = cheapestReasoning((await this.capabilities({ ...config, model })) ?? manifestCapability(model))
      if (reasoning) body.reasoning = reasoning
      const res = await fetch(`${config.lmStudioUrl.replace(/\/+$/, '')}/api/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(READINGS_TIMEOUT_MS),
      })
      if (!res.ok || !res.body) throw new Error(await describeHttpError(res))
      const readings = parseReadings(await collectMessage(res.body), wheel.aspects.map(aspectKey))
      if (!readings) throw new Error('no readings in the answer')

      // The chat may have moved on while we waited: find the message again.
      const current = this.store.get(conversationId)
      const index = current?.messages.findIndex((m) => m.id === messageId) ?? -1
      if (!current || index < 0) return null
      const messages = current.messages.map((m, i) => (i === index ? { ...m, readings } : m))
      this.store.setMessages(conversationId, messages, { touch: false, from: index })
      this.publishTail(conversationId, index)
      return readings
    } catch (err) {
      console.log(`[engine] readings skipped: ${(err as Error).message}`)
      return null
    } finally {
      releaseSlot?.()
      this.reading.delete(key)
    }
  }

  /**
   * Title every chat still on its placeholder name -- the ones from before
   * titles were written, or whose titling failed -- one at a time in the
   * background, so a backlog never crowds out a reply. Returns at once with
   * how many it will try; each title arrives as a `patch` event.
   */
  /**
   * A one-off backfill: a recap for every chat that has a summary but no
   * recap yet (compacted before recaps existed). One at a time in the
   * background; each lands as a patch event. Returns how many it will try.
   */
  recapAll({ all = false }: { all?: boolean } = {}): { candidates: number } {
    const candidates = this.store.getConversations().items
      .filter((c) => c.summary?.text && (all || !c.recap) && !c.temporary)
      .map((c) => c.id)
    if (this.store.getConfig().model && candidates.length) {
      void (async () => {
        for (const id of candidates) await this.recap(id)
      })()
    }
    return { candidates: candidates.length }
  }

  retitleAll(): { candidates: number } {
    const config = this.store.getConfig()
    const candidates = this.store.getConversations().items
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
    if (this.titling.has(conversationId)) return false
    const conv = this.store.get(conversationId)
    const config = this.store.getConfig()
    // Asked for by hand, it runs even with automatic naming switched off.
    if (!conv || (!manual && config.autoTitle === 'off') || conv.temporary || !config.model) return false
    if (!needsTitle(conv.messages, conv.name)) return false
    const input = titleInput(conv.messages, conv.createdAt)
    if (!input) return false

    this.titling.add(conversationId)
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await this.slots.acquire('background')
      const model = config.backgroundModel.trim() || config.model
      const body: Record<string, unknown> = {
        model, system_prompt: TITLE_PROMPT, input, stream: true, max_output_tokens: TITLE_MAX_TOKENS,
      }
      const reasoning = cheapestReasoning(
        (await this.capabilities({ ...config, model })) ?? manifestCapability(model),
      )
      if (reasoning) body.reasoning = reasoning

      const res = await fetch(`${config.lmStudioUrl.replace(/\/+$/, '')}/api/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      })
      if (!res.ok || !res.body) throw new Error(await describeHttpError(res))
      const name = cleanTitle(await collectMessage(res.body))
      if (!name) throw new Error('empty title')

      // Renamed, cleared or deleted while we waited: leave it be.
      const current = this.store.get(conversationId)
      if (!current || !needsTitle(current.messages, current.name)) return false
      const updated = this.store.patch(conversationId, { name }, { touch: false })
      if (updated) this.bus.send({ type: 'patch', payload: { conversationId, meta: metaOf(updated) } })
      return true
    } catch (err) {
      console.log(`[engine] titling skipped: ${(err as Error).message}`)
      return false
    } finally {
      releaseSlot?.()
      this.titling.delete(conversationId)
    }
  }

  /**
   * After /compact: a short recap of what the fold covers, written for the
   * reader from the model's own summary, and kept on the chat. Best effort.
   */
  async recap(conversationId: string): Promise<string | null> {
    const conv = this.store.get(conversationId)
    const config = this.store.getConfig()
    if (!conv?.summary?.text || !config.model) return null
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await this.slots.acquire('background')
      const model = config.backgroundModel.trim() || config.model
      const body: Record<string, unknown> = {
        model, system_prompt: RECAP_PROMPT, input: conv.summary.text, stream: true, max_output_tokens: RECAP_MAX_TOKENS,
      }
      const reasoning = cheapestReasoning((await this.capabilities({ ...config, model })) ?? manifestCapability(model))
      if (reasoning) body.reasoning = reasoning
      const res = await fetch(`${config.lmStudioUrl.replace(/\/+$/, '')}/api/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      })
      if (!res.ok || !res.body) throw new Error(await describeHttpError(res))
      const text = wholeSentences(await collectMessage(res.body))
      if (!text) throw new Error('empty recap')
      const updated = this.store.patch(conversationId, { recap: text }, { touch: false })
      if (updated) this.bus.send({ type: 'patch', payload: { conversationId, meta: metaOf(updated) } })
      return text
    } catch (err) {
      console.log(`[engine] recap skipped: ${(err as Error).message}`)
      return null
    } finally {
      releaseSlot?.()
    }
  }

  /**
   * Fold older turns into the conversation's summary if the replayed context
   * has outgrown the budget. Best effort: on any failure the thread keeps its
   * previous summary and buildHistoryPrompt's trimming covers the gap.
   */
  async compact(conversationId: string, { force = false }: { force?: boolean } = {}): Promise<boolean> {
    if (this.compacting.has(conversationId)) return false
    const conv = this.store.get(conversationId)
    if (!conv) return false
    const config = this.store.getConfig()
    const limit = historyLimit(config.historyChars)
    // Asked for (the /compact command): fold everything so far, budget or not.
    const plan = force ? planFullCompaction(conv.messages, conv.summary) : planCompaction(conv.messages, conv.summary, limit)
    if (!plan || !config.model) return false

    this.compacting.add(conversationId)
    // Summaries only take a slot no one is waiting for.
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await this.slots.acquire('background')
      // A model of its own, if Settings names one: summarizing is the job
      // for a small fast model, leaving the chat model to the chats.
      const model = config.backgroundModel.trim() || config.model
      const body: Record<string, unknown> = {
        model,
        system_prompt: summarizerPrompt(limit),
        input: summarizerInput(plan),
        stream: true,
        max_output_tokens: summaryTokenCap(limit),
      }
      const reasoning = cheapestReasoning(
        (await this.capabilities({ ...config, model })) ?? manifestCapability(model),
      )
      if (reasoning) body.reasoning = reasoning

      const res = await fetch(`${config.lmStudioUrl.replace(/\/+$/, '')}/api/v1/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      })
      if (!res.ok || !res.body) throw new Error(await describeHttpError(res))
      const text = (await collectMessage(res.body)).trim()
      if (!text) throw new Error('empty summary')

      // The thread may have moved on (or been cleared) while we summarized;
      // only anchor to a message that is still there.
      const current = this.store.get(conversationId)
      if (!current?.messages.some((m) => m.id === plan.through)) return false
      const updated = this.store.patch(conversationId, { summary: { text, through: plan.through } }, { touch: false })
      // So open clients can show where the summary now begins.
      if (updated) this.bus.send({ type: 'patch', payload: { conversationId, meta: metaOf(updated) } })
      console.log(
        `[engine] compacted ${plan.fold.length} messages into a ${text.length}-char summary`,
      )
      return true
    } catch (err) {
      console.log(`[engine] compaction skipped: ${(err as Error).message}`)
      return false
    } finally {
      releaseSlot?.()
      this.compacting.delete(conversationId)
    }
  }
}

function historyLimit(raw: string): number {
  const limit = Number.parseInt(raw, 10)
  return Number.isFinite(limit) ? limit : 24000
}

/** The whole wheel's readings in one answer: a slow model with a dozen aspects needs a while. */
const READINGS_TIMEOUT_MS = 3 * 60 * 1000

/** A tool message holding a transit chart with no readings yet (or any such chart, when rewriting). */
function wantsReadings(m: Message, force: boolean): boolean {
  return m.role === 'tool' && !m.failed && !!m.output && m.output.includes('"natal"') && looksLikeChart(m.output) && (force || !m.readings)
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
