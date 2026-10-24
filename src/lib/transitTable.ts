// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * The transits of a transit chart as table rows: the aspects in play at
 * the chart's moment, for the table under the wheel. Read from the parsed
 * wheel here; TransitTable.tsx draws them, and the forecast table
 * (forecastTable.ts) shares the cells and the date words. (The
 * list_upcoming_transits result gets no table: one proved not
 * meaningful in use, so don't add it back.)
 */
import { type Wheel, aspectFamily, aspectGlyph, type AspectFamily, GLYPHS, displayName, signDegrees, signName } from './chartWheel.ts'
import { chartRuler, transitWeight } from './weight.ts'

export { chartRuler }

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
  /** "21°50′ Leo": where each body is on the wheel. */
  fromPosition: string | null
  toPosition: string | null
  orb: number
  /** "2026-10-15 16:59", local; null when it is not exact in the window. */
  exact: string | null
  movement: 'applying' | 'separating' | null
  /** Every exact moment of the contact's run, and which of them `exact` is: "1 of 3" when a retrograde brings it back. */
  passes: string[]
  pass: string | null
  /** How much it weighs on the forecasts' scale (see weight.ts); null when the scale has no number for it. */
  weight: number | null
  /** The chart ruler, for the working behind the weight. */
  ruler: string
}

const movementOf = (v: unknown): TransitRow['movement'] =>
  typeof v !== 'string' ? null : v.toLowerCase().startsWith('app') ? 'applying' : v.toLowerCase().startsWith('sep') ? 'separating' : null

/** "21°50′ Leo" for a longitude. */
export function positionText(longitude: number): string {
  const { deg, min } = signDegrees(longitude)
  return `${deg}°${String(min).padStart(2, '0')}′ ${signName(longitude)}`
}

/**
 * The aspects on a transit wheel as rows: what is in play at that moment,
 * in date order of their exact moments (those with none last, tightest
 * first), each with both bodies' positions read off the rings and its
 * weight, with the chart ruler read off the Ascendant.
 */
export function activeTransits(wheel: Wheel): TransitRow[] {
  if (wheel.kind !== 'transit') return []
  const point = (ring: 'inner' | 'outer', name: string) => wheel[ring].find((p) => p.name === name)
  const ruler = chartRuler(wheel.angles.Asc)
  return wheel.aspects
    .map((a): TransitRow => {
      const from = point('outer', a.from)
      const to = point('inner', a.to)
      return {
        from: a.from, to: a.to, type: a.type,
        fromRetrograde: from?.retrograde ?? false,
        toRetrograde: to?.retrograde ?? false,
        toHouse: to?.house ?? null,
        fromPosition: from ? positionText(from.longitude) : null,
        toPosition: to ? positionText(to.longitude) : null,
        orb: a.orb,
        exact: a.exactAt,
        movement: movementOf(a.movement),
        passes: a.passes,
        pass: a.pass,
        weight: transitWeight(a.from, a.to, a.type, ruler),
        ruler,
      }
    })
    .sort((a, b) => (a.exact && b.exact ? a.exact.localeCompare(b.exact) : a.exact ? -1 : b.exact ? 1 : a.orb - b.orb))
}

/** "1°17′". */
export function orbText(orb: number): string {
  const deg = Math.floor(orb)
  const min = Math.round((orb - deg) * 60)
  return `${deg}°${String(min).padStart(2, '0')}′`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const parts = (iso: string): { year: string; month: number; day: number; time: string | null } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(iso)
  return m ? { year: m[1]!, month: Number(m[2]) - 1, day: Number(m[3]), time: m[4] ?? null } : null
}

/**
 * "Oct 14", or "Oct 14 16:59" with a time; anything unreadable as it came.
 * Given the table's own date, a day in another year carries it ("Dec 7, 2025 16:36"),
 * so a retrograde loop's exact moment last year doesn't read as this one.
 */
export function dayText(iso: string, ref?: string | null): string {
  const { day, time } = dayParts(iso, ref)
  return time ? `${day} ${time}` : day
}

/** The same, in two pieces -- "Dec 7, 2025" and "16:36" -- so a cell can break between them and nowhere else. */
export function dayParts(iso: string, ref?: string | null): { day: string; time: string | null } {
  const p = parts(iso)
  if (!p) return { day: iso, time: null }
  const year = ref && ref.slice(0, 4) !== p.year && /^\d{4}/.test(ref) ? `, ${p.year}` : ''
  return { day: `${MONTHS[p.month]} ${p.day}${year}`, time: p.time }
}


/** "Oct 14", "Oct 14–16" or "Oct 28–Nov 3": the days a contact is in orb. */
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
