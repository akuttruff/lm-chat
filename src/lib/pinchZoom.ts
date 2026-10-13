/**
 * The arithmetic of zooming a picture under the fingers: a scale and an
 * offset, changed so that whatever is under the pinch stays under it.
 *
 * Coordinates are relative to the picture's own unscaled top-left corner,
 * which is where its CSS transform-origin sits. The picture is drawn at
 * `translate(x, y) scale(scale)`.
 */

export interface ZoomState {
  scale: number
  x: number
  y: number
}

export const ZOOM_MIN = 1
export const ZOOM_MAX = 8
/** What a double tap zooms to, and back from. */
export const ZOOM_TAP = 3

export const AT_REST: ZoomState = { scale: 1, x: 0, y: 0 }

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Scaled by `factor` about the point (px, py): that point keeps its place on screen. */
export function zoomAbout(s: ZoomState, factor: number, px: number, py: number): ZoomState {
  const scale = clamp(s.scale * factor, ZOOM_MIN, ZOOM_MAX)
  const f = scale / s.scale
  return { scale, x: px - (px - s.x) * f, y: py - (py - s.y) * f }
}

export const pan = (s: ZoomState, dx: number, dy: number): ZoomState => ({ ...s, x: s.x + dx, y: s.y + dy })

/**
 * Kept within reach: the picture, `side` wide and tall and sitting at
 * `offset` inside a stage of `stage` size, may not be dragged clear of the
 * stage, and is centred on an axis it is smaller than. At rest it snaps
 * exactly home.
 */
export function constrain(
  s: ZoomState,
  stage: { width: number; height: number },
  side: number,
  offset: { x: number; y: number },
): ZoomState {
  if (s.scale <= ZOOM_MIN) return AT_REST
  const span = side * s.scale
  const axis = (value: number, stageLength: number, at: number): number => {
    // The `+ 0` turns a -0 into 0, so the transform reads cleanly.
    if (span <= stageLength) return (stageLength - span) / 2 - at + 0
    return clamp(value, stageLength - at - span, -at) + 0
  }
  return { scale: s.scale, x: axis(s.x, stage.width, offset.x), y: axis(s.y, stage.height, offset.y) }
}

/** A double tap: in to ZOOM_TAP about the tap, or home if already zoomed. */
export function toggleZoom(s: ZoomState, px: number, py: number): ZoomState {
  return s.scale > ZOOM_MIN ? AT_REST : zoomAbout(s, ZOOM_TAP, px, py)
}

export const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y)

export const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } =>
  ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
