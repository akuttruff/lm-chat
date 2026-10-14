/**
 * The transits of an astrology result as table rows.
 *
 * Two tools feed this: create_transit_chart, whose aspects are the transits
 * in play at one moment (the table sits under the wheel), and
 * list_upcoming_transits, whose spans are the contacts coming up over a
 * window (that result has no wheel: the table is the picture). Both are
 * read from the tool's JSON here; TransitTable.tsx draws them.
 */
import { type Wheel, aspectFamily, aspectGlyph, type AspectFamily, GLYPHS, displayName } from './chartWheel.ts'

export interface TransitRow {
  /** The transiting body, and the natal point (or, with no birth chart, the other body). */
  from: string
  to: string
  /** "Square", as the tool names it. */
  type: string
  fromRetrograde: boolean
  toRetrograde: boolean
  /** The natal house of the point aspected, when known. */
  toHouse: number | null
  orb: number
  /** "2026-10-15 16:59", local; null when it is not exact in the window. */
  exact: string | null
  movement: 'applying' | 'separating' | null
  /** For an upcoming span: the first and last day in orb. */
  start: string | null
  end: string | null
}

export interface UpcomingTable {
  start: string
  end: string
  /** Natal mode measures against a birth chart; general mode between the moving bodies. */
  mode: 'natal' | 'general'
  rows: TransitRow[]
  /** What the tool left out to fit, as it said it. */
  omitted: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const movementOf = (v: unknown): TransitRow['movement'] =>
  typeof v !== 'string' ? null : v.toLowerCase().startsWith('app') ? 'applying' : v.toLowerCase().startsWith('sep') ? 'separating' : null

/** Whether a tool result is a list_upcoming_transits answer: a window, and its spans. */
export function looksLikeUpcoming(text: string): boolean {
  return text.includes('"transit_range"') && text.includes('"transits"')
}

/** The spans of a list_upcoming_transits result, in the order the tool gave them; null if it is not one. */
export function parseUpcoming(text: string): UpcomingTable | null {
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  if (!isRecord(data) || !isRecord(data.transit_range) || !Array.isArray(data.transits)) return null
  const start = str(data.transit_range.start)
  const end = str(data.transit_range.end)
  if (!start || !end) return null
  // An oversized answer comes as positional arrays, with the field names once in span_fields.
  const fields = Array.isArray(data.span_fields) ? data.span_fields.filter((f): f is string => typeof f === 'string') : null
  const rows: TransitRow[] = []
  for (const raw of data.transits) {
    const span: Record<string, unknown> | null = isRecord(raw) ? raw
      : fields && Array.isArray(raw) ? Object.fromEntries(fields.map((f, i) => [f, raw[i]])) : null
    if (!span) continue
    const from = str(span.from_object)
    const to = str(span.to_object)
    const type = str(span.type)
    if (!from || !to || !type) continue
    rows.push({
      from, to, type,
      fromRetrograde: span.from_retrograde === true,
      toRetrograde: span.to_retrograde === true,
      toHouse: num(span.to_house),
      orb: num(span.orb) ?? 0,
      exact: str(span.exact),
      movement: null,
      start: str(span.start),
      end: str(span.end),
    })
  }
  const omitted = isRecord(data.omitted) ? str(data.omitted.note) ?? str(data.omitted.reason) : str(data.omitted)
  return { start, end, mode: data.mode === 'general' ? 'general' : 'natal', rows, omitted }
}

/** The aspects on a transit wheel as rows, tightest first: what is in play at that moment. */
export function activeTransits(wheel: Wheel): TransitRow[] {
  if (wheel.kind !== 'transit') return []
  const retro = (ring: 'inner' | 'outer', name: string): boolean => wheel[ring].find((p) => p.name === name)?.retrograde ?? false
  return wheel.aspects
    .map((a): TransitRow => ({
      from: a.from, to: a.to, type: a.type,
      fromRetrograde: retro('outer', a.from),
      toRetrograde: retro('inner', a.to),
      toHouse: wheel.inner.find((p) => p.name === a.to)?.house ?? null,
      orb: a.orb,
      exact: a.exactAt,
      movement: movementOf(a.movement),
      start: null, end: null,
    }))
    .sort((a, b) => a.orb - b.orb)
}

/** "1°17′". */
export function orbText(orb: number): string {
  const deg = Math.floor(orb)
  const min = Math.round((orb - deg) * 60)
  return `${deg}°${String(min).padStart(2, '0')}′`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (iso: string): { month: number; day: number; time: string | null } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(iso)
  return m ? { month: Number(m[2]) - 1, day: Number(m[3]), time: m[4] ?? null } : null
}

/** "Oct 14", or "Oct 14 16:59" with a time; anything unreadable as it came. */
export function dayText(iso: string): string {
  const p = parts(iso)
  if (!p) return iso
  return `${MONTHS[p.month]} ${p.day}${p.time ? ` ${p.time}` : ''}`
}

/** "Oct 14", "Oct 14–16" or "Oct 28–Nov 3": the days a span is in orb. */
export function windowText(start: string | null, end: string | null): string {
  if (!start) return end ? dayText(end) : ''
  if (!end || end === start) return dayText(start)
  const a = parts(start)
  const b = parts(end)
  if (!a || !b) return `${start}–${end}`
  return a.month === b.month ? `${MONTHS[a.month]} ${a.day}–${b.day}` : `${MONTHS[a.month]} ${a.day}–${MONTHS[b.month]} ${b.day}`
}

/** What a cell shows for a body: its glyph, its name, and ℞ when it is retrograde. */
export interface BodyCell { glyph: string; name: string; retrograde: boolean }
export const bodyCell = (name: string, retrograde: boolean): BodyCell => ({ glyph: GLYPHS[name] ?? '', name: displayName(name), retrograde })

/** What a cell shows for an aspect: its glyph, its name in lower case, and the family it is coloured by. */
export interface AspectCell { glyph: string; name: string; family: AspectFamily }
export const aspectCell = (type: string): AspectCell => ({ glyph: aspectGlyph(type), name: type.toLowerCase(), family: aspectFamily(type) })
