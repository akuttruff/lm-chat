/**
 * A forecast's key transits as table rows.
 *
 * forecast_week, forecast_month and forecast_year each return
 * `headline_transits`: the contacts of the period ranked by how much they
 * shape it (slow planet, central natal point, hard aspect; for a week, the
 * contacts exact within it first). The table under the result keeps the
 * ones whose weight reaches the horizon's bar, in date order, with the
 * moment each is exact and both positions. TransitTable.tsx draws it.
 */

export type Horizon = 'week' | 'month' | 'year'

export interface ForecastRow {
  from: string
  to: string
  /** "Square", as the tool names it. */
  type: string
  fromRetrograde: boolean
  toHouse: number | null
  /** The local moment it is exact, or null when it is only in orb within the period. */
  exact: string | null
  /** That moment, or else the nearest exact moment before or after the period; null when none within a year. */
  nearestExact: string | null
  /** For a contact that does not perfect in the period: whether its orb closes or opens across it. */
  movement: 'applying' | 'separating' | null
  /** The first and last day in orb. */
  start: string
  end: string
  /** "21°50′ Leo": where each body is at the exact moment (or the tightest day). */
  fromPosition: string | null
  toPosition: string | null
  orb: number
  /** "2 of 3" when a retrograde brings the same contact back, and every exact moment of that run. */
  pass: string | null
  passes: string[]
  weight: number
}

export interface ForecastTable {
  horizon: Horizon
  start: string
  end: string
  /** Every headline the tool sent, in its order. */
  rows: ForecastRow[]
}

/**
 * A contact is key when its weight reaches this: the house rule, by weight
 * and not by count. The tool's weight is the transiting planet's slowness
 * (Mercury 0.5, Venus 0.7, Sun 0.8, Mars 1, Jupiter and Chiron 3, Saturn
 * and Uranus 4, Neptune and Pluto 5), doubled on the Sun, Moon, Asc, MC
 * or chart ruler, times the aspect (conjunction and opposition 1, square
 * 0.9, trine 0.7, sextile 0.5). Three keeps the slow planets' hard
 * aspects and trines in a month or a year. A week's events are the fast
 * planets, which never reach three, so its bar is lower: Sun, Venus and
 * Mars contacts, and Mercury only on a key point.
 */
export const KEY_WEIGHT: Record<Horizon, number> = { week: 0.7, month: 3, year: 3 }

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** The tool writes minutes with a straight quote; the table uses the prime. */
const position = (v: unknown): string | null => str(v)?.replace(/'/g, '\u2032') ?? null

/** Whether a tool result is a forecast: a horizon and its ranked headlines. */
export const looksLikeForecast = (text: string): boolean => text.includes('"forecast"') && text.includes('"headline_transits"')

/** The headlines of a forecast result; null if it is not one. */
export function parseForecast(text: string): ForecastTable | null {
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  if (!isRecord(data) || !Array.isArray(data.headline_transits) || !isRecord(data.range)) return null
  const horizon = data.forecast
  if (horizon !== 'week' && horizon !== 'month' && horizon !== 'year') return null
  const start = str(data.range.start)
  const end = str(data.range.end)
  if (!start || !end) return null
  const rows: ForecastRow[] = []
  for (const h of data.headline_transits) {
    if (!isRecord(h)) continue
    const from = str(h.transiting)
    const to = str(h.natal)
    const type = str(h.aspect)
    const first = str(h.start)
    const last = str(h.end)
    if (!from || !to || !type || !first || !last) continue
    rows.push({
      from, to, type,
      fromRetrograde: h.retrograde === true,
      toHouse: num(h.natal_house),
      exact: str(h.exact),
      nearestExact: str(h.nearest_exact) ?? str(h.exact),
      movement: h.movement === 'applying' || h.movement === 'separating' ? h.movement : null,
      start: first, end: last,
      fromPosition: position(h.from_position),
      toPosition: position(h.to_position),
      orb: num(h.orb) ?? 0,
      pass: str(h.pass),
      passes: Array.isArray(h.passes) ? h.passes.filter((p): p is string => typeof p === 'string') : [],
      weight: num(h.weight) ?? 0,
    })
  }
  return { horizon, start, end, rows }
}

/** When a row happens, for ordering: the exact moment, or the first day in orb when it is never exact in the period. */
const moment = (r: ForecastRow): string => r.exact ?? r.start

/** The rows the table shows: the headlines that reach KEY_WEIGHT, in date order, the weightier first on the same moment. */
export const keyTransits = (table: ForecastTable): ForecastRow[] =>
  table.rows
    .filter((r) => r.weight >= KEY_WEIGHT[table.horizon])
    .sort((a, b) => moment(a).localeCompare(moment(b)) || b.weight - a.weight)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "Oct 14–20", "October 2026" or "Oct 14, 2026 – Oct 14, 2027": the period, for the caption. */
export function periodText(table: ForecastTable): string {
  const [y1, m1, d1] = table.start.split('-').map(Number)
  const [y2, m2, d2] = table.end.split('-').map(Number)
  if (!y1 || !m1 || !d1 || !y2 || !m2 || !d2) return `${table.start} – ${table.end}`
  const short = (m: number) => MONTHS[m - 1]!.slice(0, 3)
  if (table.horizon === 'month' && d1 === 1 && m1 === m2 && y1 === y2) return `${MONTHS[m1 - 1]} ${y1}`
  if (y1 === y2 && m1 === m2) return `${short(m1)} ${d1}–${d2}`
  if (y1 === y2) return `${short(m1)} ${d1}–${short(m2)} ${d2}`
  return `${short(m1)} ${d1}, ${y1} – ${short(m2)} ${d2}, ${y2}`
}
