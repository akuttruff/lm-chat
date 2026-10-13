import { describe, it, expect } from 'vitest'
import { AT_REST, ZOOM_MAX, ZOOM_TAP, constrain, distance, midpoint, pan, toggleZoom, zoomAbout } from './pinchZoom.ts'

describe('zoomAbout', () => {
  it('keeps the point under the fingers where it is', () => {
    // Content point c under (100, 50) at rest; after zooming x2 about it, still under (100, 50).
    const s = zoomAbout(AT_REST, 2, 100, 50)
    expect(s.scale).toBe(2)
    const c = { x: (100 - s.x) / s.scale, y: (50 - s.y) / s.scale }
    expect(c).toEqual({ x: 100, y: 50 })
  })

  it('composes: two half-zooms equal one', () => {
    const a = zoomAbout(zoomAbout(AT_REST, 1.5, 30, 30), 2, 30, 30)
    const b = zoomAbout(AT_REST, 3, 30, 30)
    expect(a.scale).toBeCloseTo(b.scale)
    expect(a.x).toBeCloseTo(b.x)
  })

  it('never goes past the limits', () => {
    expect(zoomAbout(AT_REST, 100, 0, 0).scale).toBe(ZOOM_MAX)
    expect(zoomAbout({ scale: 2, x: -10, y: -10 }, 0.1, 0, 0).scale).toBe(1)
  })
})

describe('constrain', () => {
  const stage = { width: 300, height: 500 }
  const side = 300
  const offset = { x: 0, y: 100 }

  it('snaps home at rest', () => {
    expect(constrain({ scale: 1, x: 40, y: 40 }, stage, side, offset)).toEqual(AT_REST)
  })

  it('stops the picture being dragged off the stage', () => {
    const s = constrain({ scale: 2, x: 50, y: -1000 }, stage, side, offset)
    expect(s.x).toBe(0) // can't open a gap on the left
    expect(s.y).toBe(stage.height - offset.y - side * 2) // bottom edge stays at the stage's bottom
  })

  it('centres the picture on an axis it does not fill', () => {
    // Zoomed 1.2x: 360 tall in a 500 stage; centred vertically regardless of y.
    const s = constrain({ scale: 1.2, x: 0, y: 999 }, stage, side, offset)
    expect(s.y).toBeCloseTo((500 - 360) / 2 - offset.y)
  })
})

describe('gestures', () => {
  it('double tap zooms in about the tap, and back out', () => {
    const zoomed = toggleZoom(AT_REST, 10, 20)
    expect(zoomed.scale).toBe(ZOOM_TAP)
    expect(toggleZoom(zoomed, 0, 0)).toEqual(AT_REST)
  })

  it('pans by the drag', () => {
    expect(pan({ scale: 2, x: 1, y: 1 }, 5, -5)).toEqual({ scale: 2, x: 6, y: -4 })
  })

  it('measures a pinch', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 2 })).toEqual({ x: 2, y: 1 })
  })
})
