import { describe, it, expect, vi } from 'vitest'
import { edgeSwipe } from './edgeSwipe.ts'

describe('edgeSwipe', () => {
  it('opens on a swipe in from the left edge, once', () => {
    const onOpen = vi.fn()
    const s = edgeSwipe(onOpen)
    s.start(10, 300)
    expect(s.move(40, 302)).toBe(false)
    expect(s.move(80, 305)).toBe(true)
    expect(s.move(120, 305)).toBe(false)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores a touch that starts away from the edge, or that is really a scroll', () => {
    const onOpen = vi.fn()
    const s = edgeSwipe(onOpen)
    s.start(100, 300)
    expect(s.move(200, 300)).toBe(false)
    s.start(5, 300)
    expect(s.move(30, 360)).toBe(false) // drifted down: a scroll
    expect(s.move(90, 360)).toBe(false)
    expect(onOpen).not.toHaveBeenCalled()
  })
})
