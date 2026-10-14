import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolCard from './ToolCard'
import transit from '../test/fixtures/transit-chart.json?raw'

describe('ChartWheel in a tool card', () => {
  it('draws a transit result as a wheel, without opening the card', () => {
    const { container } = render(<ToolCard name="create_transit_chart" plugin="mcp/astrology-v2" output={transit} />)
    const svg = screen.getByRole('img', { name: /Transits 2026-10-13 05:58 over the natal chart of 1984-05-10 20:44/ })
    expect(svg).toBeInTheDocument()
    // Twelve sign glyphs, and a glyph for every planet on both rings.
    expect(container.querySelectorAll('.wheel-svg text').length).toBeGreaterThan(12 + 2 * 10)
    expect(screen.getByRole('button', { name: /Save wheel as transits-2026-10-13-05-58.png/ })).toBeInTheDocument()
    // The text result is still there to read.
    expect(container.querySelector('.tc-preview')).toBeInTheDocument()
  })

  it('marks a retrograde planet with ℞ beside its degree and explains it in the legend', () => {
    const { container } = render(<ToolCard name="create_transit_chart" plugin="mcp/astrology-v2" output={transit} />)
    const marks = Array.from(container.querySelectorAll('.wheel-svg tspan.wheel-rx'))
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.every((t) => t.textContent?.trim() === '℞')).toBe(true)
    expect(container.querySelector('.wheel-legend')?.textContent).toContain('℞ retrograde')
  })

  it('draws nothing for a result that is not a chart', () => {
    const { container } = render(<ToolCard name="list_upcoming_transits" output={'{"spans": []}'} />)
    expect(container.querySelector('.wheel')).toBeNull()
  })

  it('draws nothing for a failed call', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} failed />)
    expect(container.querySelector('.wheel')).toBeNull()
  })

  it('opens full screen on a tap, to pinch into, and closes on Escape', async () => {
    const user = userEvent.setup()
    render(<ToolCard name="create_transit_chart" output={transit} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Open the wheel full screen/ }))
    const dialog = screen.getByRole('dialog', { name: /Transits 2026-10-13 05:58/ })
    expect(dialog).toBeInTheDocument()
    // Both pictures are drawn: the card's and the viewer's.
    expect(screen.getAllByRole('img', { name: /Transits 2026-10-13/ })).toHaveLength(2)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('zooms in on a double tap and offers to fit again', async () => {
    const user = userEvent.setup()
    const { baseElement } = render(<ToolCard name="create_transit_chart" output={transit} />)
    await user.click(screen.getByRole('button', { name: /Open the wheel full screen/ }))
    const stage = baseElement.querySelector('.wheel-stage')!
    const picture = baseElement.querySelector<HTMLElement>('.wheel-picture')!
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(stage, { pointerId: 1, clientX: 50, clientY: 50, pointerType: 'touch' })
      fireEvent.pointerUp(stage, { pointerId: 1, clientX: 50, clientY: 50, pointerType: 'touch' })
    }
    expect(picture.style.transform).toContain('scale(3)')
    await user.click(screen.getByRole('button', { name: 'Zoom out to fit' }))
    expect(picture.style.transform).toContain('scale(1)')
  })

  it('says what a planet is and the aspects it makes when pointed at', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const points = container.querySelectorAll('.wheel-point')
    // Natal Sun: the inner ring is drawn last, so it is among the later groups.
    const sun = [...points].find((g) => g.textContent?.includes('20°38'))!
    fireEvent.pointerEnter(sun, { pointerType: 'mouse' })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Your Sun')
    expect(tip).toHaveTextContent('20°38′ Taurus · 6th house')
    expect(tip).toHaveTextContent('Jupiter in Leo squaring your Sun in Taurus')
    fireEvent.pointerLeave(sun, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('names an aspect line when pointed at, and lights it up', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const lines = container.querySelectorAll('.wheel-aspect')
    expect(lines.length).toBeGreaterThan(1)
    fireEvent.pointerEnter(lines[0]!, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Mercury in Scorpio sextile your Midheaven in Virgo')
    expect(screen.getByRole('tooltip')).toHaveTextContent('exact 2026-10-13 16:16, orb 0°23′, applying')
    const after = container.querySelectorAll('.wheel-aspect')
    expect(after[0]!.getAttribute('opacity')).toBe('1')
    expect(after[1]!.getAttribute('opacity')).toBe('0.18')
  })

  it('under a finger, a tap holds the popup clear of the point until a tap elsewhere', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const sun = [...container.querySelectorAll('.wheel-point')].find((g) => g.textContent?.includes('20°38'))!
    fireEvent.pointerDown(sun, { pointerType: 'touch', pointerId: 1 })
    fireEvent.pointerLeave(sun, { pointerType: 'touch', pointerId: 1 })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Your Sun')
    expect(tip.className).toMatch(/above|below|left|right/)
    // The click that follows the tap did not open the viewer.
    fireEvent.click(sun)
    expect(screen.queryByRole('dialog')).toBeNull()
    // A tap on the wheel's empty parts lets it go.
    fireEvent.pointerDown(container.querySelector('.wheel-svg')!, { pointerType: 'touch', pointerId: 2 })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('with a mouse, the popup sits beside the pointer and follows it', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const sun = [...container.querySelectorAll('.wheel-point')].find((g) => g.textContent?.includes('20°38'))!
    fireEvent.pointerEnter(sun, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip').className).toMatch(/above|below|left|right/)
    fireEvent.pointerLeave(sun, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it("shows the transit's reading in the popup once written, and says it is coming until then", () => {
    const readings = { 'Mercury|Sextile|MC': 'Say the quiet thing out loud today.' }
    const { container, rerender } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const line = container.querySelectorAll('.wheel-aspect')[0]!
    fireEvent.pointerEnter(line, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('A reading for this transit is on its way.')
    rerender(<ToolCard name="create_transit_chart" output={transit} readings={readings} />)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Say the quiet thing out loud today.')
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('on its way')
    fireEvent.pointerLeave(line, { pointerType: 'mouse' })
    // The planet's popup carries the reading under its aspect line.
    const mercury = [...container.querySelectorAll('.wheel-point')].find((g) => g.textContent?.includes('15°11'))!
    fireEvent.pointerEnter(mercury, { pointerType: 'mouse' })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Transiting Mercury')
    expect(tip.querySelector('li .wheel-tip-reading')).toHaveTextContent('Say the quiet thing out loud today.')
  })
})
