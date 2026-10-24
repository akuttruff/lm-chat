// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * A forecast's key transits as table rows.
 *
 * forecast_week, forecast_month and forecast_year each return
 * `headline_transits`: the contacts of the period ranked by how much they
 * shape it (slow planet, central natal point, hard aspect; for a week, the
 * contacts exact within it first). The table under the result keeps the
 * ones whose weight reaches the horizon's bar, in date order, with the
 * moment each is exact and both positions. TransitTable.tsx draws it.
 *
 * A week may also carry `week_transits`, and a month `month_transits`
 * (Orrery's server folds them in; the tool alone never does): every
 * contact in orb over its days from the ephemeris scan, with no cap. Then the table shows all of them in two groups, the
 * period's events (exact inside it, in date order) and its backdrop (in
 * orb without perfecting, heaviest first), each weighed here the way the
 * forecasts weigh theirs.
 */
import { transitWeight } from './weight.ts'

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
  /** The chart ruler, as the tool names it, for the weights. */
  ruler: string | null
  /** A week's or a month's scan: every contact in orb over its days, as rows; null for a year, or a period cast without one. */
  scan: ForecastRow[] | null
}

/** A scanned period's rows in their two groups: exact inside the period in date order, then the rest heaviest first. */
export interface ScanGroups { events: ForecastRow[]; backdrop: ForecastRow[] }

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
  const ruler = isRecord(data.natal) ? str(data.natal.chart_ruler) : null
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
  return { horizon, start, end, rows, ruler, scan: horizon === 'year' ? null : scanRows(data[`${horizon}_transits`], rows, start, end, ruler) }
}

const contactKey = (r: { from: string; to: string; type: string }): string => `${r.from}|${r.type}|${r.to}`

/**
 * The scan's contacts as rows. A contact the headlines also carry takes
 * their movement, passes and weight, which the scan does not give; the
 * rest are weighed here. An exact moment outside the period's days (the
 * scan looks a little past them) counts as the nearest one, not an event.
 */
function scanRows(scan: unknown, headlines: ForecastRow[], start: string, end: string, ruler: string | null): ForecastRow[] | null {
  if (!isRecord(scan) || !Array.isArray(scan.transits)) return null
  const byKey = new Map(headlines.map((h) => [contactKey(h), h]))
  const rows: ForecastRow[] = []
  for (const t of scan.transits) {
    if (!isRecord(t)) continue
    const from = str(t.from_object)
    const to = str(t.to_object)
    const type = str(t.type)
    const first = str(t.start)
    const last = str(t.end)
    if (!from || !to || !type || !first || !last) continue
    const moment = str(t.exact)
    const inside = moment !== null && moment.slice(0, 10) >= start && moment.slice(0, 10) <= end
    const headline = byKey.get(contactKey({ from, to, type }))
    rows.push({
      from, to, type,
      fromRetrograde: t.from_retrograde === true,
      toHouse: num(t.to_house),
      exact: inside ? moment : null,
      nearestExact: moment ?? headline?.nearestExact ?? null,
      movement: inside ? null : headline?.movement ?? null,
      start: first, end: last,
      fromPosition: position(t.from_position),
      toPosition: position(t.to_position),
      orb: num(t.orb) ?? 0,
      pass: headline?.pass ?? null,
      passes: headline?.passes ?? (moment ? [moment] : []),
      weight: headline?.weight ?? transitWeight(from, to, type, ruler) ?? 0,
    })
  }
  return rows
}

/** A scanned period's two groups, or null when it has no scan. */
export function scanGroups(table: ForecastTable): ScanGroups | null {
  if (!table.scan) return null
  const events = table.scan.filter((r) => r.exact).sort((a, b) => a.exact!.localeCompare(b.exact!))
  const backdrop = table.scan.filter((r) => !r.exact).sort((a, b) => b.weight - a.weight || a.orb - b.orb)
  return { events, backdrop }
}

/** When a row happens, for ordering: the exact moment, or the first day in orb when it is never exact in the period. */
const moment = (r: ForecastRow): string => r.exact ?? r.start

/**
 * The rows the table shows. With a scan, every contact: the events then
 * the backdrop. Without one, the headlines that reach KEY_WEIGHT, in date
 * order, the weightier first on the same moment.
 */
export function keyTransits(table: ForecastTable): ForecastRow[] {
  const groups = scanGroups(table)
  if (groups) return [...groups.events, ...groups.backdrop]
  return table.rows
    .filter((r) => r.weight >= KEY_WEIGHT[table.horizon])
    .sort((a, b) => moment(a).localeCompare(moment(b)) || b.weight - a.weight)
}

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
