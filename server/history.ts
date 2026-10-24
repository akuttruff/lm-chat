import { AUTO_LOADED } from './memory.ts'
import type { ContextSummary, Message } from '../src/types.ts'

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

export function historyLimit(raw: string): number {
  const limit = Number.parseInt(raw, 10)
  return Number.isFinite(limit) ? limit : 24000
}
