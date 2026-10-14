import { aspectDetail, displayName, natalLongitude, fromLongitude, signName, type Wheel, type WheelAspect } from './chartWheel.ts'

/**
 * A short reading for each transit on a wheel -- what that contact means
 * for the person that day -- written by the model once per chart and kept
 * on the tool message, so the popup over an aspect can show it.
 *
 * Shared by the server, which asks the model and stores the answers, and
 * the page, which looks a reading up by its aspect's key.
 */

/** Stable name for one aspect on a wheel: the moving body, the aspect, the natal point. */
export const aspectKey = (a: WheelAspect): string => `${a.from}|${a.type}|${a.to}`

/** What the model is asked for. */
export const READINGS_PROMPT = [
  'You are an astrologer writing for one person about the transits to their birth chart on one day.',
  'For each transit listed, write one reading of at most 35 words: what this contact tends to bring up for them that day, concrete and warm, addressed as "you".',
  'Do not repeat the positions or the orb; they can see those. No headings, no emoji, no hedging about astrology itself.',
  'Reply with a JSON object only, mapping each transit\'s key exactly as given to its reading.',
].join(' ')

/** Room for the answer: a reading a line, with slack for the JSON around it. */
export const readingsTokenCap = (count: number): number => Math.min(6000, 200 + 90 * count)

/**
 * The transits to read, one a line, each by its key: only a bi-wheel has
 * any (a birth chart alone has no "today"). Null when there is nothing to
 * ask about.
 */
export function readingsInput(wheel: Wheel): string | null {
  if (wheel.kind !== 'transit' || wheel.aspects.length === 0) return null
  const lines = wheel.aspects.map((a) => {
    const from = wheel.outer.find((p) => p.name === a.from)
    const to = wheel.inner.find((p) => p.name === a.to)
    const fromLon = fromLongitude(wheel, a.from)
    const toLon = natalLongitude(wheel, a.to)
    const house = (n: number | null | undefined): string => (n ? `, ${ordinal(n)} house` : '')
    const fromText = fromLon === null ? displayName(a.from) : `${displayName(a.from)} in ${signName(fromLon)}${house(from?.house)}${from?.retrograde ? ', retrograde' : ''}`
    const toText = toLon === null ? displayName(a.to) : `${displayName(a.to)} in ${signName(toLon)}${house(to?.house)}`
    return `- key: ${aspectKey(a)}\n  transiting ${fromText} ${a.type.toLowerCase()} natal ${toText}; ${aspectDetail(a)}`
  })
  return [
    `Day: ${wheel.dateTime ?? 'today'}.${wheel.natalDateTime ? ` Birth chart of ${wheel.natalDateTime}.` : ''}`,
    'Transits:',
    ...lines,
  ].join('\n')
}

/**
 * The model's answer as readings by key: a JSON object, possibly fenced or
 * wrapped in a remark, with only the keys asked for kept. A reading that is
 * not a sentence of text is dropped; nothing usable gives null.
 */
export function parseReadings(text: string, keys: string[]): Record<string, string> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const wanted = new Set(keys)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!wanted.has(key) || typeof value !== 'string') continue
    const reading = value.replace(/\s+/g, ' ').trim()
    if (reading) out[key] = reading
  }
  return Object.keys(out).length ? out : null
}

/** The sentence the popup leads with for a key, for anyone who has the wheel but not the aspect. */
export const readingFor = (readings: Record<string, string> | undefined, a: WheelAspect): string | null =>
  readings?.[aspectKey(a)] ?? null

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${tail}`
}
