/**
 * A row swiped sideways to uncover the buttons behind it, the way a phone's
 * mail app does. Tracks one pointer: once it has moved `lock` px it is
 * either a horizontal drag, which follows the finger between the row's
 * resting place and `width` px to the left, or a vertical one, which is the
 * list scrolling and is left alone. Pure, so it can be tested without a
 * browser; the row wires it to pointer events and draws the offset.
 */
export interface SwipeReveal {
  /** A pointer went down at (x, y), on a row that is `open` or not. */
  start: (x: number, y: number, open: boolean) => void
  /** Where the row should sit now, in px (0 at rest, -width fully open); null while it is not a sideways drag. */
  move: (x: number, y: number) => number | null
  /** The pointer lifted: whether the row should be open, or null for a tap that never dragged. */
  end: () => boolean | null
}

export function swipeReveal(width: number, { lock = 8 } = {}): SwipeReveal {
  let origin: { x: number; y: number; base: number } | null = null
  let axis: 'x' | 'y' | null = null
  let offset = 0
  const reset = (): void => { origin = null; axis = null; offset = 0 }
  return {
    start(x, y, open) {
      origin = { x, y, base: open ? -width : 0 }
      axis = null
      offset = origin.base
    },
    move(x, y) {
      if (!origin || axis === 'y') return null
      const dx = x - origin.x
      const dy = y - origin.y
      if (axis === null) {
        if (Math.abs(dx) < lock && Math.abs(dy) < lock) return null
        axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
        if (axis === 'y') return null
      }
      offset = Math.min(0, Math.max(-width, origin.base + dx))
      return offset
    },
    end() {
      const dragged = axis === 'x'
      const open = offset < -width / 2
      reset()
      return dragged ? open : null
    },
  }
}
