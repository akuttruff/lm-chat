import type { Bus } from './bus.ts'
import type { Store } from './store.ts'
import { newId } from './store.ts'
import { fitReasoning, manifestCapability, reasoningCapability } from './capabilities.ts'
import { describeHttpError, lmStudioBase, lmStudioFetch } from './lm-studio.ts'
import type { ReasoningCapability } from './capabilities.ts'
import { Slots, parallelLimit } from './slots.ts'
import { MEMORY_PLUGIN, Memories } from './memory.ts'
import { buildHistoryPrompt, historyLimit } from './history.ts'
import { BackgroundJobs } from './background.ts'
import { TailPublisher, replyStats, sseEvents } from './stream.ts'
import { Transcript, formatToolOutput, toolArgs, type ReplyMeta } from './transcript.ts'
import { metaOf } from '../src/types.ts'
export { formatToolOutput, toolArgs }
import { parseIntegrations } from '../src/lib/integrations.ts'
import type { Conversation, Folder, ImageUpload, Message, MessageImage, ServerConfig } from '../src/types.ts'

/**
 * Runs a turn against LM Studio, server-side.
 *
 * The browser used to do this. That meant a locked screen, a backgrounded tab
 * or a reload killed the generation outright -- LM Studio would log "Client
 * disconnected" and throw the work away. Here the turn outlives any client.
 */

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

export { parseIntegrations }

interface TurnState {
  controller: AbortController
  stalled: boolean
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
  private statuses: Map<string, StatusPayload>
  /** Each thread's messages as last sent in a tail, one JSON print per message, so the next tail can skip what has not changed. */
  private sent = new Map<string, string[]>()
  readonly slots: Slots
  private background: BackgroundJobs

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
    // ??= : state kept from before a code change may predate a field.
    const titling = state.titling ??= new Set()
    const reading = state.reading ??= new Set()
    this.statuses = state.statuses ??= new Map()
    this.slots = state.slots ??= new Slots(() => parallelLimit(this.store.getConfig().parallel))
    this.background = new BackgroundJobs(
      {
        store: this.store,
        bus: this.bus,
        slots: this.slots,
        capabilities: (config) => this.capabilities(config),
        publishTail: (conversationId, base) => this.publishTail(conversationId, base),
      },
      state.compacting,
      titling,
      reading,
    )
  }

  /**
   * Work going on after replies are released: summaries, titles and transit
   * readings. A restart cuts these off silently (a chart would keep saying
   * its reading is on its way), so the deploy script waits for zero.
   */
  backgroundJobs(): number {
    return this.background.count()
  }

  // The background jobs themselves live in background.ts; see each there.
  readingsAll(opts?: { all?: boolean }): { candidates: number } { return this.background.readingsAll(opts) }
  readings(conversationId: string, messageId: string | number, opts?: { force?: boolean }): Promise<Record<string, string> | null> {
    return this.background.readings(conversationId, messageId, opts)
  }
  recapAll(opts?: { all?: boolean }): { candidates: number } { return this.background.recapAll(opts) }
  retitleAll(): { candidates: number } { return this.background.retitleAll() }
  title(conversationId: string, opts?: { manual?: boolean }): Promise<boolean> { return this.background.title(conversationId, opts) }
  recap(conversationId: string): Promise<string | null> { return this.background.recap(conversationId) }
  compact(conversationId: string, opts?: { force?: boolean }): Promise<boolean> { return this.background.compact(conversationId, opts) }

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
    const base = lmStudioBase(config)
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

      const res = await lmStudioFetch(config, '/api/v1/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      if (completed) {
        finalize()
        this.publish(conversationId, 'live', 'connected', null)
        succeeded = true
      } else {
        // LM Studio closed the stream without a chat.end. It logs why on its
        // side (an MCP tool hitting its 60-second limit, most often) but
        // sends no error frame, so without this the turn would pass as a
        // finished reply with a tool call left hanging and nothing said.
        console.log(`[engine] stream ended without chat.end (${transcript.producedAnything() ? 'partial reply kept' : 'nothing produced'})`)
        cutShort(
          'LM Studio closed the connection before the reply finished and did not say why; its server log has the reason. ' +
          "After a tool call it is usually one of two things: the tool ran past LM Studio's 60-second limit (ask for less and retry), " +
          'or the plugin process had died (just retry).',
          'interrupted',
        )
      }
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
    }
    // Even after a stopped or failed turn: the chart it drew is there to read.
    await this.background.readingsFor(conversationId)
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
}
