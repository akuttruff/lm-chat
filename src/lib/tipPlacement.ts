// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * Where to put the popup for a pointed-at planet or aspect so that it
 * never covers what it describes. Pure geometry, in page pixels.
 *
 * The popup goes outside the wheel when the page has room there -- beside
 * it on a wide screen, above or below it on a phone -- and otherwise beside
 * the thing itself, on whichever side keeps clear of it. A finger covers
 * more than a mouse pointer, so a held popup is kept further off.
 */

export interface Box { left: number; top: number; width: number; height: number }
export interface Point { x: number; y: number }
/** What must stay visible: a planet (one point) or an aspect line (its two ends). */
export type Subject = { kind: 'point'; at: Point } | { kind: 'line'; from: Point; to: Point }

export interface Placement {
  left: number
  top: number
  /** Which way the popup sits from what it describes; for the arrow-less styling and tests. */
  side: 'left' | 'right' | 'above' | 'below'
}

const MARGIN = 8
/** How close the popup may come to what it describes. */
const CLEAR = 14

const distanceToBox = (p: Point, b: Box): number => {
  const dx = Math.max(b.left - p.x, 0, p.x - (b.left + b.width))
  const dy = Math.max(b.top - p.y, 0, p.y - (b.top + b.height))
  return Math.hypot(dx, dy)
}

/** How far a subject is from a box: the closest of its points (a line, sampled along its length). */
export function clearance(subject: Subject, box: Box): number {
  if (subject.kind === 'point') return distanceToBox(subject.at, box)
  let min = Infinity
  const steps = 24
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const p = { x: subject.from.x + (subject.to.x - subject.from.x) * t, y: subject.from.y + (subject.to.y - subject.from.y) * t }
    min = Math.min(min, distanceToBox(p, box))
  }
  return min
}

/**
 * The two spots either side of a line, square off its middle: far enough
 * along the normal that the popup's corner nearest the line still clears
 * it. Upward first for a finger.
 */
function squareOff(line: { from: Point; to: Point }, anchor: Point, size: { width: number; height: number }, off: number, held: boolean): Placement[] {
  const dx = line.to.x - line.from.x
  const dy = line.to.y - line.from.y
  const length = Math.hypot(dx, dy)
  if (length === 0) return []
  const n = { x: -dy / length, y: dx / length }
  const reach = off + CLEAR + Math.abs(n.x) * size.width / 2 + Math.abs(n.y) * size.height / 2
  const spots = [1, -1].map((sign): Placement => {
    const centre = { x: anchor.x + n.x * sign * reach, y: anchor.y + n.y * sign * reach }
    const side = Math.abs(n.y) >= Math.abs(n.x) ? (n.y * sign < 0 ? 'above' : 'below') : (n.x * sign > 0 ? 'right' : 'left')
    return { left: centre.x - size.width / 2, top: centre.y - size.height / 2, side }
  })
  return held ? spots.sort((a, b) => a.top - b.top) : spots
}

const anchorOf = (subject: Subject): Point =>
  subject.kind === 'point' ? subject.at : { x: (subject.from.x + subject.to.x) / 2, y: (subject.from.y + subject.to.y) / 2 }

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi))

const fits = (b: Box, viewport: { width: number; height: number }): boolean =>
  b.left >= MARGIN && b.top >= MARGIN && b.left + b.width <= viewport.width - MARGIN && b.top + b.height <= viewport.height - MARGIN

/**
 * The spot for a popup of `size` describing `subject`, drawn over a wheel
 * that occupies `wheel` on a page `viewport` big. `held` for a finger.
 */
export function placeTip(
  subject: Subject,
  size: { width: number; height: number },
  wheel: Box,
  viewport: { width: number; height: number },
  held: boolean,
): Placement {
  const anchor = anchorOf(subject)
  const { width, height } = size
  const gap = 12
  // Centred on the subject along the wheel's edge, kept on the page.
  const alongY = clamp(anchor.y - height / 2, MARGIN, viewport.height - MARGIN - height)
  const alongX = clamp(anchor.x - width / 2, MARGIN, viewport.width - MARGIN - width)
  const outside: Placement[] = [
    { left: wheel.left + wheel.width + gap, top: alongY, side: 'right' },
    { left: wheel.left - gap - width, top: alongY, side: 'left' },
    { left: alongX, top: wheel.top + wheel.height + gap, side: 'below' },
    { left: alongX, top: wheel.top - gap - height, side: 'above' },
  ]
  for (const p of outside) {
    const box = { ...p, width, height }
    if (fits(box, viewport) && clearance(subject, box) >= CLEAR) return p
  }

  // No room outside: beside the subject itself. A finger wants the popup
  // above, well clear of the hand; a mouse wants it to the side. For a
  // line, first the two spots square off its middle, which no line through
  // the wheel's centre can cross.
  const off = held ? 56 : 28
  const axis: Placement[] = held
    ? [
      { left: alongX, top: anchor.y - off - height, side: 'above' },
      { left: alongX, top: anchor.y + off, side: 'below' },
      { left: anchor.x + off, top: alongY, side: 'right' },
      { left: anchor.x - off - width, top: alongY, side: 'left' },
    ]
    : [
      { left: anchor.x + off, top: alongY, side: 'right' },
      { left: anchor.x - off - width, top: alongY, side: 'left' },
      { left: alongX, top: anchor.y - off - height, side: 'above' },
      { left: alongX, top: anchor.y + off, side: 'below' },
    ]
  const near = [...(subject.kind === 'line' ? squareOff(subject, anchor, size, off, held) : []), ...axis]
    .map((p) => ({ ...p, left: clamp(p.left, MARGIN, viewport.width - MARGIN - width), top: clamp(p.top, MARGIN, viewport.height - MARGIN - height) }))
  let best: { p: Placement; clear: number } | null = null
  for (const p of near) {
    const box = { ...p, width, height }
    if (!fits(box, viewport)) continue
    const clear = clearance(subject, box)
    if (clear >= CLEAR) return p
    if (!best || clear > best.clear) best = { p, clear }
  }
  if (best) return best.p
  // Nothing fits whole (a popup taller than the page): pin it to the page's corner nearest the subject's far side.
  return { left: alongX, top: clamp(anchor.y + off, MARGIN, Math.max(MARGIN, viewport.height - MARGIN - height)), side: 'below' }
}
