import type { Store } from './store.ts'
import { fitReasoning, manifestCapability, type ReasoningCapability } from './capabilities.ts'
import { MEMORY_PLUGIN, type Memories } from './memory.ts'
import { buildHistoryPrompt, historyLimit } from './history.ts'
import { parseIntegrations } from '../src/lib/integrations.ts'
import type { Conversation, Folder, Message, MessageImage, ServerConfig } from '../src/types.ts'

/**
 * A turn's request to /api/v1/chat, assembled: the input as the model sees
 * it, the limits, the reasoning level, the tools and the system prompt.
 */

/** What a request is assembled from besides the chat, its folder and Settings. */
export interface RequestSources {
  /** Where this turn's pictures are read back from. */
  readImage: Store['readImage']
  /** How to learn what a model accepts. */
  capabilities: (config: ServerConfig) => Promise<ReasoningCapability | null>
  /** The shared memory pool, read into the prompt for chats with memory on. */
  memories: Memories
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

/** The request's `input`: plain text, or text-and-image parts when the message has images. */
export function inputFor(readImage: Store['readImage'], text: string, images: MessageImage[] | undefined): string | Record<string, string>[] {
  const stamped = stampInput(text)
  if (!images?.length) return stamped
  const parts: Record<string, string>[] = [{ type: 'text', content: stamped }]
  for (const img of images) {
    const stored = readImage(img.id)
    // Gone from disk (a backup restored elsewhere): the name still tells the model something was here.
    if (!stored) { parts[0]!.content = `[image ${img.name} is no longer available]\n\n${stamped}`; continue }
    parts.push({ type: 'image', data_url: `data:${stored.mime};base64,${stored.bytes.toString('base64')}` })
  }
  return parts
}

/**
 * The request for one turn: the model, the input (with this turn's
 * pictures), the limits, the reasoning level, the tools, and the whole
 * conversation replayed as the system prompt. Settings resolve chat, then
 * folder, then global.
 */
export async function requestFor(
  sources: RequestSources,
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
  const body: Record<string, unknown> = { model: config.model, input: inputFor(sources.readImage, text, sent.images), stream: true }
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
    ? fitReasoning(requested, (await sources.capabilities(config)) ?? manifestCapability(config.model))
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
  const memory = memoryOn ? sources.memories.context(4000, conv.memorySelection ?? folder?.memorySelection) : null
  // The date note goes first and never changes, so it costs the prompt
  // cache nothing; the stamp it refers to rides on each message (see
  // stampInput).
  const systemPrompt = [DATE_NOTE, config.systemPrompt.trim(), memory?.block].filter(Boolean).join('\n\n')
  const prompt = buildHistoryPrompt(systemPrompt, history, limit, conv.summary)
  if (prompt) body.system_prompt = prompt
  return { body, cap, memory }
}
