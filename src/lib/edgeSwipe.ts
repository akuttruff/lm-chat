/**
 * A swipe in from the left edge, the way a phone opens a side menu. Tracks
 * one touch: it must start within `edge` px of the left side and travel
 * `distance` px to the right without wandering far up or down. Pure, so it
 * can be tested without a browser; App wires it to touch events.
 */
export interface EdgeSwipe {
  start: (x: number, y: number) => void
  move: (x: number, y: number) => boolean
  end: () => void
}

export function edgeSwipe(onOpen: () => void, { edge = 24, distance = 60, drift = 40 } = {}): EdgeSwipe {
  let origin: { x: number; y: number } | null = null
  return {
    start(x, y) { origin = x <= edge ? { x, y } : null },
    move(x, y) {
      if (!origin) return false
      if (Math.abs(y - origin.y) > drift) { origin = null; return false }
      if (x - origin.x < distance) return false
      origin = null
      onOpen()
      return true
    },
    end() { origin = null },
  }
}
