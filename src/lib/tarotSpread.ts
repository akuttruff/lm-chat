// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * A tarot reading in a tool result (the tarot-mcp server's draw_cards),
 * laid out the way the spread is read: a row for a line of cards, the
 * cross and staff for a Celtic Cross. The pictures are the public-domain
 * Rider-Waite-Smith scans, served from /tarot/<id>.jpg unless the app
 * serves them elsewhere (imageFor's `base`).
 */

export interface DrawnCard {
  position: { index: number; name: string; meaning: string }
  card: { id: string; name: string; arcana: 'major' | 'minor'; suit: string | null; number: number }
  reversed: boolean
  keywords: string[]
  meaning: string
}

export interface Reading {
  spread: { id: string; name: string; description: string }
  question: string | null
  seed: number
  cards: DrawnCard[]
}

export const looksLikeReading = (output: string): boolean =>
  output.includes('"spread"') && output.includes('"cards"') && output.includes('"drawnAt"')

/** The reading in a tool result, or null when the result is not one. */
export function parseReading(output: string): Reading | null {
  let data: unknown
  try { data = JSON.parse(output) } catch { return null }
  if (!data || typeof data !== 'object') return null
  const d = data as Partial<Reading>
  if (!d.spread || typeof d.spread.id !== 'string' || !Array.isArray(d.cards) || d.cards.length === 0) return null
  const cards = d.cards.filter((c) => c && c.card && typeof c.card.id === 'string' && c.position && typeof c.position.name === 'string')
  if (cards.length !== d.cards.length) return null
  return { spread: d.spread, question: typeof d.question === 'string' ? d.question : null, seed: typeof d.seed === 'number' ? d.seed : 0, cards }
}

/** A card's picture: /tarot/<id>.jpg, or under another `base`. */
export const imageFor = (id: string, base = '/tarot/'): string => `${base}${id}.jpg`

/** A card's place in the picture: in card widths and heights from the top left, and how it is turned. */
export interface Slot { x: number; y: number; turn: number }

export interface Layout {
  kind: 'row' | 'cross'
  /** The picture's size in card widths and heights. */
  cols: number
  rows: number
  slots: Slot[]
}

/** The Celtic Cross: the cross on the left, the staff of four on the right, read bottom to top. */
const CELTIC: Slot[] = [
  { x: 1.15, y: 1.0, turn: 0 },   // 1 the present
  { x: 1.15, y: 1.0, turn: 90 },  // 2 the challenge, crossing it
  { x: 1.15, y: 2.15, turn: 0 },  // 3 below
  { x: 0, y: 1.0, turn: 0 },      // 4 left
  { x: 1.15, y: -0.15, turn: 0 }, // 5 above
  { x: 2.3, y: 1.0, turn: 0 },    // 6 right
  { x: 3.7, y: 3.15, turn: 0 },   // 7 staff, bottom
  { x: 3.7, y: 2.05, turn: 0 },   // 8
  { x: 3.7, y: 0.95, turn: 0 },   // 9
  { x: 3.7, y: -0.15, turn: 0 },  // 10 staff, top
]

/** How a spread is laid out: ten cards as the cross, anything else as a row that wraps. */
export function layoutFor(spreadId: string, count: number): Layout {
  if (spreadId === 'celtic-cross' && count === 10) return { kind: 'cross', cols: 4.7, rows: 4.3, slots: CELTIC }
  return { kind: 'row', cols: Math.min(count, 5), rows: Math.ceil(count / 5), slots: Array.from({ length: count }, (_, i) => ({ x: i % 5, y: Math.floor(i / 5), turn: 0 })) }
}

/** The card's picture, turned: a reversed card is upside down; the crossing card lies across, and both when both. */
export const turnOf = (slot: Slot, reversed: boolean): number => (slot.turn + (reversed ? 180 : 0)) % 360
