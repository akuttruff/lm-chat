import { describe, it, expect } from 'vitest'
import { clearance, placeTip, type Box, type Subject } from './tipPlacement.ts'

const size = { width: 300, height: 120 }
const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top

describe('placing the popup', () => {
  it('goes beside the wheel when the page is wide enough', () => {
    const wheel: Box = { left: 100, top: 100, width: 600, height: 600 }
    const subject: Subject = { kind: 'point', at: { x: 150, y: 400 } }
    const spot = placeTip(subject, size, wheel, { width: 1400, height: 900 }, false)
    expect(spot.side).toBe('right')
    expect(spot.left).toBe(712)
    expect(overlaps({ ...spot, ...size }, wheel)).toBe(false)
  })

  it('goes below or above the wheel on a phone, never over it', () => {
    const wheel: Box = { left: 0, top: 200, width: 400, height: 400 }
    const spot = placeTip({ kind: 'point', at: { x: 200, y: 300 } }, size, wheel, { width: 400, height: 900 }, true)
    expect(spot.side).toBe('below')
    expect(spot.top).toBe(612)
    expect(overlaps({ ...spot, ...size }, wheel)).toBe(false)
    // Centred on the subject, but kept on the page.
    expect(spot.left).toBe(50)
    const edge = placeTip({ kind: 'point', at: { x: 20, y: 300 } }, size, wheel, { width: 400, height: 900 }, true)
    expect(edge.left).toBe(8)
  })

  it('with no room outside, sits clear of the line it describes', () => {
    // The zoomed viewer: the wheel fills the page.
    const wheel: Box = { left: -200, top: -200, width: 1200, height: 1200 }
    const line: Subject = { kind: 'line', from: { x: 100, y: 100 }, to: { x: 700, y: 700 } }
    const spot = placeTip(line, size, wheel, { width: 800, height: 800 }, false)
    expect(clearance(line, { ...spot, ...size })).toBeGreaterThanOrEqual(14)
    // A finger: above the middle of the line, further off than a mouse.
    const held = placeTip(line, size, wheel, { width: 800, height: 800 }, true)
    expect(held.side).toBe('above')
    expect(clearance(line, { ...held, ...size })).toBeGreaterThanOrEqual(14)
  })

  it('takes the least bad spot when nothing is fully clear', () => {
    const wheel: Box = { left: 0, top: 0, width: 300, height: 300 }
    const line: Subject = { kind: 'line', from: { x: 0, y: 150 }, to: { x: 300, y: 150 } }
    const spot = placeTip(line, { width: 290, height: 140 }, wheel, { width: 300, height: 300 }, false)
    expect(spot.left).toBeGreaterThanOrEqual(8)
    expect(spot.top).toBeGreaterThanOrEqual(8)
  })

  it('measures clearance from a point or a line to a box', () => {
    const box: Box = { left: 100, top: 100, width: 100, height: 100 }
    expect(clearance({ kind: 'point', at: { x: 150, y: 150 } }, box)).toBe(0)
    expect(clearance({ kind: 'point', at: { x: 50, y: 150 } }, box)).toBe(50)
    expect(clearance({ kind: 'line', from: { x: 0, y: 0 }, to: { x: 300, y: 300 } }, box)).toBe(0)
    expect(clearance({ kind: 'line', from: { x: 0, y: 250 }, to: { x: 300, y: 250 } }, box)).toBe(50)
  })
})
