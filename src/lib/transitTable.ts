/**
 * The transits of a transit chart as table rows: the aspects in play at
 * the chart's moment, for the table under the wheel. Read from the parsed
 * wheel here; TransitTable.tsx draws them. (list_upcoming_transits gets no
 * table: Amie found one not meaningful, so don't add it back.)
 */
import { type Wheel, aspectFamily, aspectGlyph, type AspectFamily, GLYPHS, displayName } from './chartWheel.ts'

export interface TransitRow {
  /** The transiting body, and the natal point. */
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
}

const movementOf = (v: unknown): TransitRow['movement'] =>
  typeof v !== 'string' ? null : v.toLowerCase().startsWith('app') ? 'applying' : v.toLowerCase().startsWith('sep') ? 'separating' : null

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


/** What a cell shows for a body: its glyph, its name, and ℞ when it is retrograde. */
export interface BodyCell { glyph: string; name: string; retrograde: boolean }
export const bodyCell = (name: string, retrograde: boolean): BodyCell => ({ glyph: GLYPHS[name] ?? '', name: displayName(name), retrograde })

/** What a cell shows for an aspect: its glyph, its name in lower case, and the family it is coloured by. */
export interface AspectCell { glyph: string; name: string; family: AspectFamily }
export const aspectCell = (type: string): AspectCell => ({ glyph: aspectGlyph(type), name: type.toLowerCase(), family: aspectFamily(type) })
