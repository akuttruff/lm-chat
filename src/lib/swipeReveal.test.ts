import { describe, it, expect } from 'vitest'
import { swipeReveal } from './swipeReveal.ts'

describe('swipeReveal', () => {
  it('follows a sideways drag between the row at rest and fully open, and settles to the nearer', () => {
    const s = swipeReveal(200)
    s.start(300, 50, false)
    expect(s.move(296, 51)).toBeNull() // not yet a drag
    expect(s.move(250, 52)).toBe(-50)
    expect(s.move(0, 52)).toBe(-200) // no further than the buttons
    expect(s.move(400, 52)).toBe(0) // and never past its resting place
    expect(s.move(180, 52)).toBe(-120)
    expect(s.end()).toBe(true)
    s.start(100, 50, true)
    expect(s.move(150, 50)).toBe(-150) // from open, the drag starts where the row sits
    expect(s.move(250, 50)).toBe(-50)
    expect(s.end()).toBe(false)
  })

  it('leaves a vertical drag -- the list scrolling -- alone, even if it later wanders sideways', () => {
    const s = swipeReveal(200)
    s.start(300, 50, false)
    expect(s.move(301, 70)).toBeNull()
    expect(s.move(200, 90)).toBeNull()
    expect(s.end()).toBeNull()
  })

  it('tells a tap from a drag', () => {
    const s = swipeReveal(200)
    s.start(300, 50, false)
    expect(s.end()).toBeNull()
    s.start(300, 50, true)
    s.move(302, 51)
    expect(s.end()).toBeNull()
  })
})
