/**
 * What a turn has produced so far: the messages after the history, shaped
 * by the model's events as they arrive -- reasoning, the reply, tool calls
 * and their results -- and the rules for which of them are shown. Pure
 * state: the engine feeds it events and asks for the messages. It never
 * touches the network, the store or the bus, so it is tested on its own.
 */
import { newId } from './store.ts'
import { AUTO_LOADED } from './memory.ts'
import type { ChatEvent, Message, ReplyStats } from '../src/types.ts'

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
/** Parameters longer than this, as JSON, are kept cut down: they're for reading, not replaying. */
const MAX_TOOL_ARGS = 8000

/** A tool call's parameters from an LM Studio event: an object, within MAX_TOOL_ARGS, or nothing. */
export function toolArgs(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const json = JSON.stringify(raw)
  if (json.length <= MAX_TOOL_ARGS) return raw as Record<string, unknown>
  // Each value cut down in turn, so every name still shows.
  const share = Math.max(80, Math.floor(MAX_TOOL_ARGS / Math.max(1, Object.keys(raw).length)))
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    return [k, text.length > share ? `${text.slice(0, share)}… (${text.length} characters)` : v]
  }))
}

/** What a finished reply is stamped with. */
export interface ReplyMeta {
  model: string
  instance: string | null
  /** Seconds since the turn began, to one decimal. */
  elapsed: string
  responseId: string | null
}

export class Transcript {
  /** The turn's messages so far, after the history, in order. */
  readonly produced: Message[] = []
  /** Tool messages whose result has arrived. The model can issue several calls at once, and their results come in any order. */
  private settled = new Set<Message>()
  private assistantId: string | null = null
  private acc = ''
  private reasoningId: string | null = null
  private racc = ''
  private reasoningStart = 0

  constructor(private readonly history: Message[]) {}

  /**
   * The thread as it should be shown and saved right now. Placeholders that
   * have produced nothing yet are left out: shown, they flicker in and out;
   * saved, their removal looks like lost messages and triggers a backup.
   */
  visible(): Message[] {
    return [
      ...this.history,
      ...this.produced
        .filter((m) => !(m.streaming && (m.role === 'assistant' || m.role === 'reasoning') && !(m.text || '').trim()))
        .map((m) => ({ ...m })),
    ]
  }

  /** The thread with everything, for an error to go after. */
  all(): Message[] {
    return [...this.history, ...this.produced]
  }

  /** Whether the model gave anything at all; the memory note alone does not count. */
  producedAnything(): boolean {
    return this.produced.some((m) => m.role !== 'tool' || m.plugin !== AUTO_LOADED)
  }

  /** The notes loaded for this reply without a tool call: shown, so it is visible what the model started from. */
  noteMemories(used: { text: string }[]): void {
    if (!used.length) return
    const n = used.length
    this.produced.push({
      id: newId(), role: 'tool', name: 'memory', plugin: AUTO_LOADED, failed: false,
      output: `${n} ${n === 1 ? 'memory' : 'memories'} loaded into this reply:\n` + used.map((m) => `- ${m.text}`).join('\n'),
    })
  }

  startReasoning(): void {
    this.dropEmptyAssistant()
    this.reasoningId = newId()
    this.racc = ''
    this.reasoningStart = Date.now()
    this.produced.push({ id: this.reasoningId, role: 'reasoning', text: '', streaming: true })
  }

  reasoningDelta(text: string): void {
    this.racc += text
    if (this.reasoningId === null) {
      this.reasoningId = newId()
      this.reasoningStart = Date.now()
      this.produced.push({ id: this.reasoningId, role: 'reasoning', text: this.racc, streaming: true })
    } else {
      const msg = this.produced.find((m) => m.id === this.reasoningId)
      if (msg) msg.text = this.racc
    }
  }

  /** Reasoning is over: kept with how long it took, or dropped if it said nothing. */
  closeReasoning(): void {
    if (this.reasoningId === null) return
    const msg = this.produced.find((m) => m.id === this.reasoningId)
    if (msg) {
      if (!(msg.text || '').trim()) {
        const i = this.produced.indexOf(msg)
        if (i !== -1) this.produced.splice(i, 1)
      } else {
        msg.streaming = false
        msg.elapsed = ((Date.now() - this.reasoningStart) / 1000).toFixed(1)
      }
    }
    this.reasoningId = null
    this.racc = ''
  }

  messageDelta(text: string): void {
    this.acc += text
    if (this.assistantId === null) {
      this.assistantId = newId()
      this.produced.push({ id: this.assistantId, role: 'assistant', text: this.acc, streaming: true })
    } else {
      const msg = this.produced.find((m) => m.id === this.assistantId)
      if (msg) msg.text = this.acc
    }
  }

  /** The reply ended: stamped and closed, or dropped if it was empty (a tool call may follow). */
  endMessage(meta: ReplyMeta): void {
    this.closeReasoning()
    if (this.assistantId !== null && this.acc.trim() === '') {
      this.dropEmptyAssistant()
      return
    }
    if (this.assistantId !== null) {
      const msg = this.produced.find((m) => m.id === this.assistantId)
      if (msg) {
        msg.text = (msg.text || '').trim()
        this.stamp(msg, meta)
      }
    }
    this.assistantId = null
    this.acc = ''
  }

  /** A reply placeholder that never got a word is taken out again. */
  dropEmptyAssistant(): void {
    if (this.assistantId !== null && this.acc.trim() === '') {
      const i = this.produced.findIndex((m) => m.id === this.assistantId)
      if (i !== -1) this.produced.splice(i, 1)
    }
    this.assistantId = null
    this.acc = ''
  }

  /** A tool call begins. `tool_call.start` carries no name in practice, despite the docs: it comes in the events after. */
  startTool(name: string | undefined): void {
    this.closeReasoning()
    this.dropEmptyAssistant()
    this.produced.push({ id: newId(), role: 'tool', name, output: '', failed: false })
  }

  /** The newest call learns its name, plugin and parameters. */
  nameTool(name: string, plugin: string | undefined, args: unknown): void {
    const lastTool = [...this.produced].reverse().find((m) => m.role === 'tool' && m.plugin !== AUTO_LOADED)
    if (!lastTool) return
    lastTool.name = name
    if (plugin) lastTool.plugin = plugin
    const parsed = toolArgs(args)
    if (parsed) lastTool.args = parsed
  }

  /** A call's result, kept in full (within MAX_TOOL_OUTPUT), on the call it belongs to. */
  toolResult(evt: ChatEvent): void {
    const lastTool = this.claimTool(evt)
    if (!lastTool) return
    lastTool.output = formatToolOutput(evt.output).slice(0, MAX_TOOL_OUTPUT)
    const args = toolArgs(evt.arguments)
    if (args) lastTool.args = args
    // Last chance to learn the name, if neither earlier event did.
    if (!lastTool.name && (evt.tool_name || evt.tool)) lastTool.name = evt.tool_name || evt.tool
  }

  /** A call failed: marked on the call it belongs to, or as a call of its own if none was announced. */
  toolFailure(evt: ChatEvent): void {
    const lastTool = this.claimTool(evt)
    if (lastTool) {
      lastTool.failed = true
      lastTool.output = evt.reason || 'Tool call failed'
      const args = toolArgs(evt.arguments)
      if (args) lastTool.args = args
    } else {
      this.produced.push({
        id: newId(), role: 'tool',
        name: evt.tool_name || evt.metadata?.tool_name || 'tool',
        output: evt.reason || 'Tool call failed', failed: true,
      })
    }
  }

  /**
   * The call a result belongs to: by name and parameters when the event
   * says, else the oldest still waiting. Matching the newest message, as
   * before, sent every result of a parallel batch into the last call and
   * left the others empty -- a transit chart with no wheel.
   */
  private claimTool(evt: ChatEvent): Message | undefined {
    const waiting = this.produced.filter((m) => m.role === 'tool' && m.plugin !== AUTO_LOADED && !this.settled.has(m))
    if (!waiting.length) return undefined
    const name = evt.tool_name || evt.tool || evt.metadata?.tool_name
    const args = toolArgs(evt.arguments)
    const byArgs = args && waiting.find((m) => m.args && JSON.stringify(m.args) === JSON.stringify(args) && (!name || m.name === name))
    const byName = name && waiting.find((m) => m.name === name)
    const chosen = byArgs || byName || waiting[0]!
    this.settled.add(chosen)
    return chosen
  }

  /** The turn's numbers go on the reply that ends it: that is the message whose footer shows them. */
  setStats(stats: ReplyStats | null): void {
    const reply = [...this.produced].reverse().find((m) => m.role === 'assistant')
    if (stats && reply) reply.stats = stats
  }

  /**
   * The turn is over, however it ended: reasoning closed, and a reply still
   * open is finished with what it has -- or, if it has nothing and something
   * else was produced, dropped.
   */
  finish(meta: ReplyMeta): void {
    this.closeReasoning()
    if (this.assistantId === null) return
    const producedSomething = this.produced.some(
      (m) => (m.role === 'tool' && m.plugin !== AUTO_LOADED) || m.role === 'reasoning' ||
        (m.role === 'assistant' && m.id !== this.assistantId && m.text),
    )
    if (this.acc.trim() === '' && producedSomething) {
      this.dropEmptyAssistant()
      return
    }
    const msg = this.produced.find((m) => m.id === this.assistantId)
    if (msg) {
      msg.text = this.acc.trim() || '(empty response)'
      this.stamp(msg, meta)
    }
  }

  private stamp(msg: Message, meta: ReplyMeta): void {
    msg.streaming = false
    msg.model = meta.model
    msg.instance = meta.instance ?? undefined
    msg.elapsed = meta.elapsed
    if (meta.responseId) msg.responseId = meta.responseId
  }
}
