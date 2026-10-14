/**
 * A chart wheel read out of an astrology tool's result.
 *
 * The astro MCP server returns charts as JSON: `objects` keyed by name,
 * each with a decimal `longitude`, `houses` keyed by number with a `cusp`,
 * and `aspects` between named points. A transit chart also carries
 * `natal.positions`, the birth chart it is measured against. That is
 * everything a wheel needs, so the picture is drawn here from the data the
 * model already has, rather than sent back through it as an image.
 *
 * This module is the data side: parsing, and the geometry that places
 * things on a circle. ChartWheel.tsx draws it.
 */

export interface WheelPoint {
  /** The tool's own name for it: "Sun", "True North Node", ... */
  name: string
  glyph: string
  /** Ecliptic longitude, 0-360. */
  longitude: number
  retrograde: boolean
  /** The house it falls in -- for a transiting body, the natal house. */
  house: number | null
}

export interface WheelAspect {
  from: string
  to: string
  /** "Conjunction", "Square", ... as the tool names it. */
  type: string
  orb: number
  /** "Applicative" or "Separative", when the tool says. */
  movement: string | null
  /** The local moment it is or was exact, when the tool says. */
  exactAt: string | null
  /** Every exact moment of the contact's run (a retrograde's passes), and which of them exactAt is: "1 of 3". */
  passes: string[]
  pass: string | null
}

export interface Wheel {
  kind: 'natal' | 'transit'
  /** The chart's moment, as the tool wrote it. For transits, the transit moment. */
  dateTime: string | null
  /** For transits, the birth moment the natal ring shows. */
  natalDateTime: string | null
  /** The natal ring, nearest the centre. */
  inner: WheelPoint[]
  /** The transiting bodies, outside it; empty for a single wheel. */
  outer: WheelPoint[]
  /** House cusp longitudes, house 1 first. */
  cusps: number[]
  /** The natal angles: a wheel is turned so the Ascendant sits at the left. */
  angles: { Asc: number; MC: number | null }
  /** In a transit wheel, `from` is a transiting body and `to` a natal point. */
  aspects: WheelAspect[]
}

/**
 * U+FE0E after each glyph asks for the text form: iOS otherwise draws the
 * zodiac signs (and Venus and Mars) as colour emoji.
 */
const T = '︎'
export const GLYPHS: Record<string, string> = {
  Sun: `☉${T}`, Moon: `☽${T}`, Mercury: `☿${T}`, Venus: `♀${T}`, Mars: `♂${T}`,
  Jupiter: `♃${T}`, Saturn: `♄${T}`, Uranus: `♅${T}`, Neptune: `♆${T}`, Pluto: `♇${T}`,
  Chiron: `⚷${T}`,
  'True North Node': `☊${T}`, 'North Node': `☊${T}`,
  'True South Node': `☋${T}`, 'South Node': `☋${T}`,
}
export const SIGN_GLYPHS = ['♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓']
  .map((g) => g + T)
export const SIGN_NAMES = ['Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo', 'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces']
export type Element = 'fire' | 'earth' | 'air' | 'water'
export const ELEMENTS: Element[] = ['fire', 'earth', 'air', 'water']
/** Aries is fire, Taurus earth, Gemini air, Cancer water, and round again. */
export const elementOf = (signIndex: number): Element => ELEMENTS[signIndex % 4]!

/** Which ring order the glyphs are drawn in, so a conjunction's glyphs stack predictably. */
const POINT_ORDER = Object.keys(GLYPHS)

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export const norm = (lon: number): number => ((lon % 360) + 360) % 360

const longitudeOf = (entry: unknown): number | null => (isRecord(entry) ? num(entry.longitude) : null)

function pointsOf(map: Record<string, unknown>): WheelPoint[] {
  const points: WheelPoint[] = []
  for (const name of POINT_ORDER) {
    const entry = map[name]
    const longitude = longitudeOf(entry)
    if (longitude === null) continue
    const speed = isRecord(entry) ? num(entry.speed) : null
    const flagged = isRecord(entry) && entry.retrograde === true
    const house = isRecord(entry) ? num(entry.house) : null
    points.push({ name, glyph: GLYPHS[name]!, longitude: norm(longitude), retrograde: flagged || (speed !== null && speed < 0), house })
  }
  return points
}

/** Cusp longitudes in house order, or null unless all twelve are there. */
function cuspsOf(houses: Record<string, unknown>): number[] | null {
  const cusps: number[] = []
  for (let n = 1; n <= 12; n++) {
    const cusp = isRecord(houses[String(n)]) ? num((houses[String(n)] as Record<string, unknown>).cusp) : null
    if (cusp === null) return null
    cusps.push(norm(cusp))
  }
  return cusps
}

function aspectsOf(raw: unknown): WheelAspect[] {
  if (!Array.isArray(raw)) return []
  const out: WheelAspect[] = []
  for (const a of raw) {
    if (!isRecord(a)) continue
    const { from_object: from, to_object: to, type } = a
    if (typeof from !== 'string' || typeof to !== 'string' || typeof type !== 'string') continue
    out.push({
      from, to, type, orb: num(a.orb) ?? 0,
      movement: typeof a.movement === 'string' ? a.movement : null,
      exactAt: typeof a.exact_at === 'string' ? a.exact_at : null,
      passes: Array.isArray(a.passes) ? a.passes.filter((p): p is string => typeof p === 'string') : [],
      pass: typeof a.pass === 'string' ? a.pass : null,
    })
  }
  return out
}

/** A cheap look before parsing: does this result have a chart's two tables in it? */
export const looksLikeChart = (output: string): boolean =>
  output.includes('"houses"') && output.includes('"objects"')

/**
 * The wheel in a tool result, or null when the result is not a chart. A
 * transit chart (with its natal positions) becomes a bi-wheel; any other
 * chart with objects, houses and an Ascendant -- natal, solar return,
 * progressed -- a single wheel.
 */
export function parseWheel(output: string): Wheel | null {
  const text = output.trim()
  if (!text.startsWith('{')) return null
  let data: unknown
  try { data = JSON.parse(text) } catch { return null }
  if (!isRecord(data) || !isRecord(data.objects) || !isRecord(data.houses)) return null
  const cusps = cuspsOf(data.houses)
  if (!cusps) return null

  const natal = isRecord(data.natal) ? data.natal : null
  const transit = data.chart_type === 'transit' && natal !== null && isRecord(natal.positions)
  const innerSource = transit ? (natal!.positions as Record<string, unknown>) : data.objects
  const asc = longitudeOf(innerSource.Asc)
  if (asc === null) return null
  const mc = longitudeOf(innerSource.MC)

  const wheel: Wheel = {
    kind: transit ? 'transit' : 'natal',
    dateTime: typeof data.date_time === 'string' ? data.date_time : null,
    natalDateTime: transit && typeof natal!.date_time === 'string' ? natal!.date_time : null,
    inner: pointsOf(innerSource),
    outer: transit ? pointsOf(data.objects) : [],
    cusps,
    angles: { Asc: norm(asc), MC: mc === null ? null : norm(mc) },
    aspects: [],
  }
  // Only aspects between points the wheel draws: one to the Part of Fortune, say, has nowhere to go.
  wheel.aspects = aspectsOf(data.aspects).filter((a) => fromLongitude(wheel, a.from) !== null && natalLongitude(wheel, a.to) !== null)
  return wheel
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where a longitude points on screen, in degrees counter-clockwise from
 * three o'clock: the Ascendant at nine o'clock and the zodiac running
 * counter-clockwise from it, as charts are drawn.
 */
export const screenAngle = (longitude: number, asc: number): number => 180 + (longitude - asc)

/** The point at radius r along a screen angle, with y growing downwards as in SVG. */
export function polar(cx: number, cy: number, r: number, angle: number): [number, number] {
  const a = (angle * Math.PI) / 180
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}

/**
 * Longitudes nudged apart so glyphs drawn at them don't overlap: any two
 * neighbours around the circle end up at least minGap degrees apart, each
 * moved as little as possible and a crowd spread evenly about its centre.
 * A pointer at the true longitude shows where a glyph was moved from.
 */
export function spread(longitudes: number[], minGap: number): number[] {
  const n = longitudes.length
  if (n < 2) return longitudes.slice()
  const gap = Math.min(minGap, 360 / n)
  const order = longitudes.map((lon, i) => ({ lon: norm(lon), i })).sort((a, b) => a.lon - b.lon)
  const pos = order.map((o) => o.lon)
  for (let pass = 0; pass < 200; pass++) {
    let moved = false
    for (let k = 0; k < n; k++) {
      const next = (k + 1) % n
      const between = pos[next]! - pos[k]! + (next === 0 ? 360 : 0)
      if (between < gap - 1e-6) {
        const push = (gap - between) / 2
        pos[k]! -= push
        pos[next]! += push
        moved = true
      }
    }
    if (!moved) break
  }
  const out: number[] = Array.from({ length: n }, () => 0)
  order.forEach((o, k) => { out[o.i] = norm(pos[k]!) })
  return out
}

/** Degrees and minutes within the sign: 50.6369 -> 20°38' Taurus. */
export function signDegrees(longitude: number): { sign: number; deg: number; min: number } {
  const lon = norm(longitude)
  const sign = Math.floor(lon / 30)
  const within = lon - sign * 30
  let deg = Math.floor(within)
  let min = Math.round((within - deg) * 60)
  if (min === 60) { min = 0; deg += 1 }
  return { sign, deg, min }
}

export type AspectFamily = 'conjunction' | 'hard' | 'soft' | 'minor'

/** How an aspect is drawn: oppositions and squares in one colour, trines and sextiles another. */
export function aspectFamily(type: string): AspectFamily {
  switch (type.toLowerCase()) {
    case 'conjunction': return 'conjunction'
    case 'opposition': case 'square': return 'hard'
    case 'trine': case 'sextile': return 'soft'
    default: return 'minor'
  }
}

// ---------------------------------------------------------------------------
// In words, for the popup when a planet or an aspect is pointed at
// ---------------------------------------------------------------------------

export type Ring = 'inner' | 'outer'

/** "True North Node" -> "North Node"; the angles by their full names. */
export function displayName(name: string): string {
  switch (name) {
    case 'Asc': return 'Ascendant'
    case 'MC': return 'Midheaven'
    case 'Desc': return 'Descendant'
    case 'IC': return 'IC'
    default: return name.replace(/^True /, '')
  }
}

/** The standard glyph for each aspect: what the chart tool sends in `symbol`, and what the popup shows. */
const ASPECT_GLYPHS: Record<string, string> = {
  conjunction: '\u260c', opposition: '\u260d', square: '\u25a1', trine: '\u25b3', sextile: '\u26b9',
  quincunx: '\u26bb', semisextile: '\u26ba', 'semi-sextile': '\u26ba', semisquare: '\u2220', 'semi-square': '\u2220',
  sesquiquadrate: '\u26bc', quintile: 'Q', biquintile: 'bQ', septile: 'S', novile: 'N', parallel: '\u2225', contraparallel: '\u22d5',
}

/** "☌" for a conjunction, "⚹" for a sextile; '' for an aspect without a glyph. */
export const aspectGlyph = (type: string): string => ASPECT_GLYPHS[type.toLowerCase()] ?? ''

const VERBS: Record<string, string> = {
  conjunction: 'conjunct', opposition: 'opposing', square: 'squaring', trine: 'trine', sextile: 'sextile',
  quincunx: 'quincunx', semisextile: 'semi-sextile', 'semi-sextile': 'semi-sextile',
}

export const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/** The sign a longitude is in, by name. */
export const signName = (longitude: number): string => SIGN_NAMES[signDegrees(longitude).sign]!

/** A natal point's longitude: a planet on the inner ring, or an angle. */
export function natalLongitude(wheel: Wheel, name: string): number | null {
  const point = wheel.inner.find((p) => p.name === name)
  if (point) return point.longitude
  switch (name) {
    case 'Asc': return wheel.angles.Asc
    case 'Desc': return norm(wheel.angles.Asc + 180)
    case 'MC': return wheel.angles.MC
    case 'IC': return wheel.angles.MC === null ? null : norm(wheel.angles.MC + 180)
    default: return null
  }
}

/** The moving end of an aspect: a transiting body on a transit wheel, else a natal point. */
export const fromLongitude = (wheel: Wheel, name: string): number | null =>
  wheel.kind === 'transit' ? (wheel.outer.find((p) => p.name === name)?.longitude ?? null) : natalLongitude(wheel, name)

/** "Moon in Scorpio opposing your Sun in Taurus" -- or, on a natal wheel, "Sun in Taurus squaring Jupiter in Capricorn". */
export function aspectSentence(wheel: Wheel, a: WheelAspect): string {
  const verb = VERBS[a.type.toLowerCase()] ?? a.type.toLowerCase()
  const from = fromLongitude(wheel, a.from)
  const to = natalLongitude(wheel, a.to)
  const fromText = from === null ? displayName(a.from) : `${displayName(a.from)} in ${signName(from)}`
  const toText = to === null ? displayName(a.to) : `${displayName(a.to)} in ${signName(to)}`
  return `${fromText} ${verb} ${wheel.kind === 'transit' ? 'your ' : ''}${toText}`
}

/** "exact 2026-10-12 23:43, pass 1 of 3 (also 2027-02-21 10:07, 2027-06-02 09:19), orb 0°23′, applying" -- whatever of it is known. */
export function aspectDetail(a: WheelAspect): string {
  const deg = Math.floor(a.orb)
  const min = Math.round((a.orb - deg) * 60)
  const parts: string[] = []
  if (a.exactAt) parts.push(`exact ${a.exactAt}`)
  if (a.pass) {
    const others = a.passes.filter((p) => p !== a.exactAt)
    parts.push(`pass ${a.pass}${others.length ? ` (also ${others.join(', ')})` : ''}`)
  }
  parts.push(`orb ${deg}°${String(min).padStart(2, '0')}′`)
  if (a.movement) parts.push(a.movement.toLowerCase().startsWith('app') ? 'applying' : 'separating')
  return parts.join(', ')
}

/** Which aspects a point on a ring is part of, as indexes into wheel.aspects. */
export function aspectsOfPoint(wheel: Wheel, ring: Ring, name: string): number[] {
  const out: number[] = []
  wheel.aspects.forEach((a, i) => {
    const moving = wheel.kind === 'transit' ? ring === 'outer' : true
    const fixed = wheel.kind === 'transit' ? ring === 'inner' : true
    if ((moving && a.from === name) || (fixed && a.to === name)) out.push(i)
  })
  return out
}

export interface PointSummary {
  /** "Transiting Moon" / "Your Sun" / "Sun". */
  title: string
  /** "23°51′ Scorpio · 12th house". */
  position: string
  /** One sentence per aspect it is in; empty when it makes none. */
  aspects: string[]
}

/** Whether any planet on the wheel is retrograde, so the legend explains the ℞. */
export const hasRetrograde = (wheel: Wheel): boolean => [...wheel.inner, ...wheel.outer].some((p) => p.retrograde)

/** What the popup says for a planet on a ring. */
export function describePoint(wheel: Wheel, ring: Ring, point: WheelPoint): PointSummary {
  const { deg, min } = signDegrees(point.longitude)
  const title = wheel.kind !== 'transit' ? displayName(point.name)
    : ring === 'outer' ? `Transiting ${displayName(point.name)}` : `Your ${displayName(point.name)}`
  const where = [`${deg}°${String(min).padStart(2, '0')}′ ${signName(point.longitude)}`]
  if (point.house !== null) where.push(`${ordinal(point.house)} house`)
  if (point.retrograde) where.push('℞ retrograde')
  return {
    title,
    position: where.join(' · '),
    aspects: aspectsOfPoint(wheel, ring, point.name).map((i) => aspectSentence(wheel, wheel.aspects[i]!)),
  }
}
