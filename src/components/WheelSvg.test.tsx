import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WheelCaption, WheelSvg } from './WheelSvg'
import { parseWheel, wheelTitle } from '../lib/chartWheel.ts'
import transit from '../test/fixtures/transit-chart.json?raw'

const wheel = parseWheel(transit)!
/** The degree labels: "24°23" and the like, one per planet on each ring. */
const degreeLabels = (root: Element) => [...root.querySelectorAll('.wheel-point text')].filter((t) => /°/.test(t.textContent ?? ''))

describe('WheelSvg', () => {
  it('draws each planet\'s degree beside its glyph, as by default', () => {
    const { container } = render(<WheelSvg wheel={wheel} title={wheelTitle(wheel)} />)
    expect(degreeLabels(container)).toHaveLength(wheel.inner.length + wheel.outer.length)
  })

  it('leaves the degree to the popup when asked, a retrograde planet keeping a small ℞ by its glyph', () => {
    const { container } = render(<WheelSvg wheel={wheel} title={wheelTitle(wheel)} degrees={false} />)
    expect(degreeLabels(container)).toHaveLength(0)
    const retrograde = [...wheel.inner, ...wheel.outer].filter((p) => p.retrograde).length
    expect(retrograde).toBeGreaterThan(0)
    expect(container.querySelectorAll('.wheel-point text.wheel-rx')).toHaveLength(retrograde)
  })

  it('tells the card the drawn picture, for a PNG of it', () => {
    let drawn: SVGSVGElement | null = null
    render(<WheelSvg wheel={wheel} title={wheelTitle(wheel)} onSvg={(el) => { drawn = el }} />)
    expect(drawn).toBe(screen.getByRole('img', { name: wheelTitle(wheel) }))
  })
})

describe('WheelCaption', () => {
  it('titles the wheel, keys its rings and aspects, and ends with what the card adds', () => {
    render(<figure><WheelCaption wheel={wheel} title={wheelTitle(wheel)}><button type="button">Save</button></WheelCaption></figure>)
    const caption = screen.getByText(wheelTitle(wheel)).closest('figcaption')!
    expect(caption).toHaveTextContent('transits')
    expect(caption).toHaveTextContent('retrograde')
    expect(caption.lastElementChild).toBe(screen.getByRole('button', { name: 'Save' }))
  })
})
