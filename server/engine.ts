import type { Bus } from './bus.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { readModelConfig } from './model-config.ts'
import { canTurnOff, cheapestReasoning, fitReasoning, reasoningCapability } from './capabilities.ts'
import type { ReasoningCapability } from './capabilities.ts'
import { Slots, parallelLimit } from './slots.ts'
import type { ChatEvent, ContextSummary, Integration, Message, ServerConfig } from '../src/types.ts'

/**
 * Runs a turn against LM Studio, server-side.
 *
 * The browser used to do this. That meant a locked screen, a backgrounded tab
 * or a reload killed the generation outright -- LM Studio would log "Client
 * disconnected" and throw the work away. Here the turn outlives any client.
 */

// LM Studio wraps tool results in a content envelope, e.g.
// [{"type":"text","text":"Friday, September 25..."}]. Show the text.
export function formatToolOutput(raw: unknown): string {
  if (raw == null) return ''
  let v: unknown = raw
  if (typeof v === 'string') {
    const asString = v
    const trimmed = asString.trim()
    if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return asString
    try { v = JSON.parse(trimmed) } catch { return asString }
  }
  const parts: unknown[] = Array.isArray(v) ? v : [v]
  const texts = parts
    .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string'
      ? (p as { text: string }).text
      : null))
    .filter((t): t is string => t !== null)
  if (texts.length) return texts.join('\n')
  return typeof raw === 'string' ? raw : JSON.stringify(v)
}

/**
 * Tool results are kept in full rather than clipped for display: a later turn
 * often depends on the data a tool returned (a natal chart, a search result),
 * and a truncated copy is worse than useless. The UI collapses them instead.
 *
 * Sized above what the MCP tools actually emit -- a year of transits runs to
 * roughly 20KB -- so the cap is a guard against a runaway tool, not something
 * a normal result ever meets.
 */
const MAX_TOOL_OUTPUT = 50000

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
  if (m.role === 'tool') return Boolean((m.output || '').trim())
  return false
}

function transcriptLine(m: Message, maxOutput = Infinity): string {
  if (m.role === 'user') return `User: ${(m.text || '').trim()}`
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

export function summarizerInput(plan: CompactionPlan): string {
  return [
    plan.previous ? `Previous summary:\n\n${plan.previous.text.trim()}` : '',
    'New turns to fold in:',
    plan.fold.filter(replayable).map((m) => transcriptLine(m, SUMMARY_TOOL_OUTPUT)).join('\n\n'),
  ].filter(Boolean).join('\n\n')
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

export function parseIntegrations(mcpTools: string): Integration[] {
  return (mcpTools || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    // LM Studio wants fully-qualified plugin ids; accept a bare label too.
    .map((id): Integration => ({ type: 'plugin', id: id.includes('/') ? id : `mcp/${id}` }))
}

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
 * Which turns and compactions are in flight. Held apart from the Engine so a
 * dev-server restart, which builds a new Engine from fresh code, still knows
 * about requests the old one started -- otherwise the "already in flight"
 * guard resets and a retry queues a duplicate behind the original.
 */
export interface EngineState {
  running: Map<string, TurnState>
  compacting: Set<string>
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
  private statuses: Map<string, StatusPayload>
  readonly slots: Slots

  constructor(
    private store: Store,
    private bus: Bus,
    /** How to learn what a model accepts; injectable so tests needn't stub LM Studio twice. */
    private capabilities: (config: ServerConfig) => Promise<ReasoningCapability | null> = reasoningCapability,
    state: EngineState = newEngineState(),
  ) {
    this.running = state.running
    this.compacting = state.compacting
    // ??= : state kept from before a code change may predate a field.
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

  private publishConversations(): void {
    this.bus.send({ type: 'conversations', payload: this.store.getConversations() })
  }

  /**
   * Append the user's message and generate a reply. Resolves when the turn
   * finishes; callers may ignore the promise, since progress is published on
   * the bus and persisted as it goes.
   */
  async runTurn(conversationId: string, text: string): Promise<void> {
    const conv = this.store.get(conversationId)
    if (!conv) throw new Error('no such conversation')
    if (this.running.has(conversationId)) throw new Error('a reply is already in flight')
    // Claimed before the first await, so a second send can't slip in meanwhile.
    const controller = new AbortController()
    const turn: TurnState = { controller, stalled: false }
    this.running.set(conversationId, turn)

    const config = this.store.getConfig()
    const history = [...conv.messages]
    const base = config.lmStudioUrl.replace(/\/+$/, '')

    // A pending throttled update, which a commit must cancel so a stale
    // snapshot can never land after the final state.
    let publishTimer: ReturnType<typeof setTimeout> | undefined
    let lastPersist = Date.now()

    const commit = (messages: Message[]): void => {
      clearTimeout(publishTimer)
      publishTimer = undefined
      this.store.setMessages(conversationId, messages)
      lastPersist = Date.now()
      this.publishConversations()
    }

    const fail = (message: string, statusText: string): void => {
      commit([...history, { id: newId(), role: 'error', text: message }])
      this.publish(conversationId, '', statusText, null)
    }

    const userMsg: Message = { id: newId(), role: 'user', text }
    history.push(userMsg)
    commit(history)

    if (!config.model) {
      this.running.delete(conversationId)
      fail('No model selected. Choose one in Settings.', 'no model')
      return
    }

    const startedAt = Date.now()
    this.publish(conversationId, 'pending', 'thinking...', startedAt)

    const body: Record<string, unknown> = { model: config.model, input: text, stream: true }
    const ctx = Number.parseInt(config.contextLength, 10)
    // Applied at load time: sending it every turn makes LM Studio JIT-load a new
    // model instance per message instead of reusing the loaded one.
    if (Number.isFinite(ctx) && ctx > 0) body.context_length = ctx
    // A chat's saved level may predate a model switch (medium, say, on a
    // model that only takes off|on), which LM Studio rejects outright.
    const requested = conv.reasoning ?? (config.reasoning || null)
    const reasoning = requested
      ? fitReasoning(requested, (await this.capabilities(config)) ?? manifestCapability(config.model))
      : null
    if (reasoning) body.reasoning = reasoning
    const integrations = parseIntegrations(config.mcpTools)
    if (integrations.length) body.integrations = integrations
    // Every turn carries its own context, so no turn depends on the last one
    // having succeeded.
    const limit = historyLimit(config.historyChars)
    const prompt = buildHistoryPrompt(config.systemPrompt, history, limit, conv.summary)
    if (prompt) body.system_prompt = prompt

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

    const produced: Message[] = []
    let assistantId: string | null = null
    let acc = ''
    let reasoningId: string | null = null
    let racc = ''
    let reasoningStart = 0
    let completed = false
    let turnResponseId: string | null = null

    // Placeholders that have produced nothing yet are left out: shown, they
    // flicker in and out; saved, their removal looks like lost messages and
    // triggers a backup.
    const visible = (): Message[] => [
      ...history,
      ...produced
        .filter((m) => !(m.streaming && (m.role === 'assistant' || m.role === 'reasoning') && !(m.text || '').trim()))
        .map((m) => ({ ...m })),
    ]

    const publishNow = (): void => {
      publishTimer = undefined
      const now = Date.now()
      const persist = now - lastPersist >= PERSIST_INTERVAL_MS
      if (persist) lastPersist = now
      this.store.setMessages(conversationId, visible(), { persist })
      const conv = this.store.get(conversationId)
      if (conv) this.bus.send({ type: 'conversation', payload: conv })
    }

    /** Streaming progress: coalesced, so a fast model can't flood clients or the disk. */
    const snapshot = (): void => {
      if (publishTimer === undefined) publishTimer = setTimeout(publishNow, PUBLISH_INTERVAL_MS)
    }

    const dropEmptyAssistant = (): void => {
      if (assistantId !== null && acc.trim() === '') {
        const i = produced.findIndex((m) => m.id === assistantId)
        if (i !== -1) produced.splice(i, 1)
      }
      assistantId = null
      acc = ''
    }

    const closeReasoning = (): void => {
      if (reasoningId === null) return
      const msg = produced.find((m) => m.id === reasoningId)
      if (msg) {
        if (!(msg.text || '').trim()) {
          const i = produced.indexOf(msg)
          if (i !== -1) produced.splice(i, 1)
        } else {
          msg.streaming = false
          msg.elapsed = ((Date.now() - reasoningStart) / 1000).toFixed(1)
        }
      }
      reasoningId = null
      racc = ''
    }

    const finalize = (): void => {
      closeReasoning()
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      const producedSomething = produced.some(
        (m) => m.role === 'tool' || m.role === 'reasoning' ||
          (m.role === 'assistant' && m.id !== assistantId && m.text),
      )
      if (assistantId !== null && acc.trim() === '' && producedSomething) {
        dropEmptyAssistant()
      } else if (assistantId !== null) {
        const msg = produced.find((m) => m.id === assistantId)
        if (msg) {
          msg.text = acc.trim() || '(empty response)'
          msg.streaming = false
          msg.model = config.model
          msg.instance = instance ?? undefined
          msg.elapsed = elapsed
          if (turnResponseId) msg.responseId = turnResponseId
        }
      }
      commit(visible())
    }

    let instance: string | null = null
    let succeeded = false
    let releaseSlot: (() => void) | undefined

    try {
      // Wait here rather than inside LM Studio, where a queued request is
      // silent: the watchdog starts only once the model is really on it.
      if (!this.slots.free('turn')) {
        this.publish(conversationId, 'pending', 'waiting for a free slot...', startedAt)
        releaseSlot = await this.slots.acquire('turn', controller.signal)
        this.publish(conversationId, 'pending', 'thinking...', startedAt)
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

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        armWatchdog() // progress: the server is still talking
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, '')
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          let evt: ChatEvent
          try { evt = JSON.parse(payload) as ChatEvent } catch { continue }

          switch (evt.type) {
            case 'chat.start':
              if (evt.model_instance_id) instance = evt.model_instance_id
              break
            case 'model_load.start':
              this.publish(conversationId, 'pending', 'loading model...', startedAt)
              break
            case 'model_load.progress':
              this.publish(conversationId, 'pending',
                `loading model ${Math.round((evt.progress || 0) * 100)}%`, startedAt)
              break
            case 'prompt_processing.start':
              this.publish(conversationId, 'pending', 'reading prompt...', startedAt)
              break
            case 'prompt_processing.progress':
              this.publish(conversationId, 'pending',
                `reading prompt ${Math.round((evt.progress || 0) * 100)}%`, startedAt)
              break
            case 'reasoning.start': {
              this.publish(conversationId, 'pending', 'reasoning...', startedAt)
              dropEmptyAssistant()
              reasoningId = newId()
              racc = ''
              reasoningStart = Date.now()
              produced.push({ id: reasoningId, role: 'reasoning', text: '', streaming: true })
              snapshot()
              break
            }
            case 'reasoning.delta': {
              racc += evt.content || ''
              if (reasoningId === null) {
                reasoningId = newId()
                reasoningStart = Date.now()
                produced.push({ id: reasoningId, role: 'reasoning', text: racc, streaming: true })
              } else {
                const msg = produced.find((m) => m.id === reasoningId)
                if (msg) msg.text = racc
              }
              snapshot()
              break
            }
            case 'reasoning.end':
              closeReasoning()
              snapshot()
              break
            case 'message.start':
              this.publish(conversationId, 'pending', 'writing...', startedAt)
              closeReasoning()
              break
            case 'message.delta': {
              acc += evt.content || ''
              if (assistantId === null) {
                assistantId = newId()
                produced.push({ id: assistantId, role: 'assistant', text: acc, streaming: true })
              } else {
                const msg = produced.find((m) => m.id === assistantId)
                if (msg) msg.text = acc
              }
              snapshot()
              break
            }
            case 'message.end': {
              closeReasoning()
              if (assistantId !== null && acc.trim() === '') {
                dropEmptyAssistant()
                snapshot()
                break
              }
              if (assistantId !== null) {
                const msg = produced.find((m) => m.id === assistantId)
                if (msg) {
                  msg.text = (msg.text || '').trim()
                  msg.streaming = false
                  msg.model = config.model
                  msg.instance = instance ?? undefined
                  msg.elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
                  if (turnResponseId) msg.responseId = turnResponseId
                }
              }
              assistantId = null
              acc = ''
              snapshot()
              break
            }
            case 'tool_call.start': {
              closeReasoning()
              dropEmptyAssistant()
              // `tool_call.start` carries no name in practice, despite the
              // docs: it arrives in the `tool_call.name` event that follows.
              produced.push({ id: newId(), role: 'tool', name: evt.tool, output: '', failed: false })
              this.publish(conversationId, 'pending', 'calling a tool...', startedAt)
              snapshot()
              break
            }
            case 'tool_call.name':
            case 'tool_call.arguments': {
              const name = evt.tool_name || evt.tool
              if (!name) break
              const lastTool = [...produced].reverse().find((m) => m.role === 'tool')
              if (lastTool) {
                lastTool.name = name
                const plugin = evt.provider_info?.plugin_id
                if (plugin) lastTool.plugin = plugin
              }
              this.publish(conversationId, 'pending', `using ${name}...`, startedAt)
              snapshot()
              break
            }
            case 'tool_call.success': {
              const lastTool = [...produced].reverse().find((m) => m.role === 'tool')
              if (lastTool) {
                lastTool.output = formatToolOutput(evt.output).slice(0, MAX_TOOL_OUTPUT)
                // Last chance to learn the name, if neither earlier event did.
                if (!lastTool.name && (evt.tool_name || evt.tool)) {
                  lastTool.name = evt.tool_name || evt.tool
                }
              }
              snapshot()
              break
            }
            case 'tool_call.failure': {
              const lastTool = [...produced].reverse().find((m) => m.role === 'tool')
              if (lastTool) {
                lastTool.failed = true
                lastTool.output = evt.reason || 'Tool call failed'
              } else {
                produced.push({
                  id: newId(), role: 'tool',
                  name: evt.tool_name || evt.metadata?.tool_name || 'tool',
                  output: evt.reason || 'Tool call failed', failed: true,
                })
              }
              snapshot()
              break
            }
            case 'error':
              throw new Error(evt.error?.message || 'LM Studio reported an error')
            case 'chat.end':
              completed = true
              if (evt.result?.response_id) {
                turnResponseId = evt.result.response_id
                this.store.patch(conversationId, { responseId: turnResponseId })
              }
              break
            default:
              break
          }
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
        finalize()
        commit([...history, ...produced, {
          id: newId(), role: 'error',
          text: `No output from LM Studio for ${stallSeconds}s, so the reply was ` +
            'abandoned. It may still be working on a long tool call.',
        }])
        this.publish(conversationId, '', 'no response', null)
      } else if ((err as Error)?.name === 'AbortError') {
        finalize()
        commit([...history, ...produced, { id: newId(), role: 'error', text: 'Stopped.' }])
        this.publish(conversationId, '', 'stopped', null)
      } else if (produced.length) {
        finalize()
        commit([...history, ...produced, {
          id: newId(), role: 'error',
          text: `The reply was cut short: ${(err as Error).message}`,
        }])
        this.publish(conversationId, '', 'interrupted', null)
      } else {
        fail(
          `Couldn't reach LM Studio at ${base}. Check that its server is running. ` +
          `(${(err as Error).message})`,
          "can't reach LM Studio",
        )
      }
    } finally {
      clearTimeout(watchdog)
      clearTimeout(publishTimer)
      releaseSlot?.()
      this.running.delete(conversationId)
      this.publishConversations()
    }

    // After the turn is released, so the user can already send the next one;
    // that turn simply replays a little more until the summary lands.
    if (succeeded) await this.compact(conversationId)
  }

  /**
   * Fold older turns into the conversation's summary if the replayed context
   * has outgrown the budget. Best effort: on any failure the thread keeps its
   * previous summary and buildHistoryPrompt's trimming covers the gap.
   */
  async compact(conversationId: string): Promise<boolean> {
    if (this.compacting.has(conversationId)) return false
    const conv = this.store.get(conversationId)
    if (!conv) return false
    const config = this.store.getConfig()
    const limit = historyLimit(config.historyChars)
    const plan = planCompaction(conv.messages, conv.summary, limit)
    if (!plan || !config.model) return false

    this.compacting.add(conversationId)
    // Summaries only take a slot no one is waiting for.
    let releaseSlot: (() => void) | undefined
    try {
      releaseSlot = await this.slots.acquire('background')
      const body: Record<string, unknown> = {
        model: config.model,
        system_prompt: summarizerPrompt(limit),
        input: summarizerInput(plan),
        stream: true,
      }
      const reasoning = cheapestReasoning(
        (await this.capabilities(config)) ?? manifestCapability(config.model),
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
      const updated = this.store.patch(conversationId, { summary: { text, through: plan.through } })
      // So open clients can show where the summary now begins.
      if (updated) this.bus.send({ type: 'conversation', payload: updated })
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
