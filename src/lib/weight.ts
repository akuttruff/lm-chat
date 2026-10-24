// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * How much a transit weighs: the forecasts' own ranking (astro-mcp's
 * forecast.py), worked out here for the aspects of a transit chart, which
 * the tool sends unweighted. A forecast's headlines carry the tool's
 * number, which this reproduces, so the two tables read on one scale.
 *
 * The weight is the transiting planet's slowness -- the slower, the rarer
 * and longer the transit, the more it shapes a period -- doubled on a key
 * natal point (the Sun, Moon, Ascendant, MC or the chart ruler), times the
 * aspect. The Moon is added here: the tool never headlines her, but
 * a day's table is full of her, so she weighs a little below Mercury.
 */

export const SLOWNESS: Record<string, number> = {
  Moon: 0.2, Mercury: 0.5, Venus: 0.7, Sun: 0.8, Mars: 1,
  Jupiter: 3, Chiron: 3, Saturn: 4, Uranus: 4, Neptune: 5, Pluto: 5,
}

export const ASPECT_WEIGHT: Record<string, number> = { Conjunction: 1, Opposition: 1, Square: 0.9, Trine: 0.7, Sextile: 0.5 }

/** The natal points whose transits matter most, with the chart ruler added per chart. */
export const KEY_POINTS = new Set(['Sun', 'Moon', 'Asc', 'MC'])

/** The traditional ruler of each sign, Aries first. */
const RULERS = ['Mars', 'Venus', 'Mercury', 'Moon', 'Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Saturn', 'Jupiter']

/** The chart ruler: the traditional ruler of the sign on the Ascendant. */
export const chartRuler = (asc: number): string => RULERS[Math.floor((((asc % 360) + 360) % 360) / 30)]!

/** The heaviest a transit can be: Pluto on the Sun. */
export const MAX_WEIGHT = 10

/** A transit's weight, or null for a body or an aspect the scale has no number for. */
export function transitWeight(from: string, to: string, type: string, ruler: string | null): number | null {
  const slowness = SLOWNESS[from]
  const aspect = ASPECT_WEIGHT[type]
  if (slowness === undefined || aspect === undefined) return null
  const key = KEY_POINTS.has(to) || to === ruler ? 2 : 1
  return Math.round(slowness * key * aspect * 100) / 100
}

/** "5.4", "0.35": the number as the tool writes it, without trailing zeros. */
export const weightText = (weight: number): string => String(Math.round(weight * 100) / 100)

/** One transit's working: the three factors and what they come to. */
export interface WeightParts {
  slowness: number
  aspect: number
  /** Why it is doubled: the key point it lands on, 'chart ruler', or null when it is not. */
  doubled: string | null
  weight: number
}

/**
 * The working behind a weight. With the chart ruler known (a transit
 * chart) the doubling is read off the point; with only the tool's number
 * (a forecast, which names no ruler) it is read off the number, and the
 * rest is the same arithmetic.
 */
export function weightParts(from: string, to: string, type: string, ruler: string | null, given: number | null = null): WeightParts | null {
  const slowness = SLOWNESS[from]
  const aspect = ASPECT_WEIGHT[type]
  if (slowness === undefined || aspect === undefined) return null
  const base = slowness * aspect
  const doubled = KEY_POINTS.has(to) ? to
    : ruler !== null ? (to === ruler ? 'chart ruler' : null)
    : given !== null && Math.abs(given - base * 2) < Math.abs(given - base) ? 'chart ruler' : null
  const weight = given ?? Math.round(base * (doubled ? 2 : 1) * 100) / 100
  return { slowness, aspect, doubled, weight }
}
