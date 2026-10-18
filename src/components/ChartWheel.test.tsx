import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolCard from './ToolCard'
import transit from '../test/fixtures/transit-chart.json?raw'
import week from '../test/fixtures/forecast-week.json?raw'
import year from '../test/fixtures/forecast-year.json?raw'

describe('ChartWheel in a tool card', () => {
  it('draws a transit result as a wheel, without opening the card', () => {
    const { container } = render(<ToolCard name="create_transit_chart" plugin="mcp/astrology-v2" output={transit} />)
    const svg = screen.getByRole('img', { name: /Transits 2026-10-13 05:58 over the natal chart of 1990-06-15 14:30/ })
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

  it('tables the transits in play under the wheel in date order, with positions, movement and ℞', () => {
    const { container } = render(<ToolCard name="create_transit_chart" plugin="mcp/astrology-v2" output={transit} />)
    const table = container.querySelector('table.tt')!
    expect(table.querySelector('caption')?.textContent).toMatch(/^Transits on Oct 13 05:58/)
    expect(table.querySelector('thead')?.textContent).toBe('WhenTransitAspectNatal')
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((r) => r.textContent ?? '')
    expect(rows.length).toBeGreaterThan(3)
    // Saturn crossed Mars a week before the chart: dimmed as past, separating, and the second of three passes.
    expect(rows.find((r) => /Saturn.*conjunction.*Mars · 7th/.test(r))).toMatch(/^was exact Oct 5 04:39separatingpass 2 of 3 · also May 20 · Feb 11, 2027.*Saturn.*10°36′ Aries.*conjunctionorb 0°38′.*Mars · 7th11°14′ Aries$/)
    // A run still to come says so, with the year on a date outside the chart's (Uranus ℞ is backing off Mercury, and returns next summer).
    expect(rows.find((r) => /Uranus.*conjunction.*Mercury/.test(r))).toMatch(/^exact Jun 2, 2027 20:31separatingpass 1 of 3 · also Jan 20, 2028 · Mar 6, 2028/)
    expect(table.querySelectorAll('.tt-near').length).toBeGreaterThan(0)
    expect(table.querySelectorAll('.wheel-rx').length).toBeGreaterThan(0)
  })

  it('tables a forecast\'s key transits, which has no wheel: the week with times, the year with passes', () => {
    const w = render(<ToolCard name="forecast_week" plugin="mcp/astrology-v2" output={week} />)
    expect(w.container.querySelector('.wheel')).toBeNull()
    const table = w.container.querySelector('table.tt')!
    expect(table.querySelector('caption')?.textContent).toBe('Key transits · Oct 12–18')
    expect(table.querySelectorAll('tbody tr').length).toBe(JSON.parse(week).headline_transits.filter((h: { weight: number }) => h.weight >= 0.7).length)
    // Date order, with the in-orb days, the exact moment, both positions and the orb.
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((r) => r.textContent ?? '')
    expect(rows.at(-1)).toMatch(/^exact Oct 18 09:33in orb Oct 17–18.*Mercury19°06′ Scorpio.*oppositionorb 0°15′.*Venus · 8th19°06′ Taurus$/)
    // Every headline of this week perfects inside it, so the first row is the earliest event.
    expect(rows[0]).toMatch(/^exact Oct 12 02:35in orb Oct 12–14/)
    expect(table.querySelector('thead')?.textContent).toBe('WhenTransitAspectNatal')
    // The slow planets' passes, in and out of the week.
    expect(table.textContent).toMatch(/pass \d of \d · also [A-Z][a-z]{2} \d/)
    const y = render(<ToolCard name="forecast_year" plugin="mcp/astrology-v2" output={year} />)
    const yt = y.container.querySelectorAll('table.tt')[0]!
    expect(yt.querySelector('caption')?.textContent).toBe('Key transits · Oct 14, 2026 – Oct 14, 2027')
    expect(yt.querySelectorAll('tbody tr')).toHaveLength(JSON.parse(year).headline_transits.filter((h: { weight: number }) => h.weight >= 3).length)
    expect(yt.textContent).toMatch(/pass \d of \d/)
    // A contact in orb without perfecting in the period says when it does, before or after (Pluto reaches the Node only in 2028).
    expect(y.container.querySelectorAll('.tt-near').length).toBeGreaterThan(0)
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
    // Natal Mercury: the inner ring is drawn last, so it is among the later groups.
    const sun = [...points].find((g) => g.textContent?.includes('6°09'))!
    fireEvent.pointerEnter(sun, { pointerType: 'mouse' })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Your Mercury')
    expect(tip).toHaveTextContent('6°09′ Gemini · 9th house')
    expect(tip).toHaveTextContent('Uranus in Gemini conjunct your Mercury in Gemini')
    fireEvent.pointerLeave(sun, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('names an aspect line when pointed at, and lights it up', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const lines = container.querySelectorAll('.wheel-aspect')
    expect(lines.length).toBeGreaterThan(1)
    // The third line is Mars opposite the Node: a hard aspect, drawn at full strength when lit (conjunctions sit at 0.75).
    fireEvent.pointerEnter(lines[2]!, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Mars in Leo opposing your North Node in Aquarius')
    expect(screen.getByRole('tooltip')).toHaveTextContent('exact 2026-10-12 02:35, orb 0°38′, separating')
    const after = container.querySelectorAll('.wheel-aspect')
    expect(after[2]!.getAttribute('opacity')).toBe('1')
    expect(after[0]!.getAttribute('opacity')).toBe('0.18')
  })

  it('under a finger, a tap holds the popup clear of the point until a tap elsewhere', () => {
    const { container } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const sun = [...container.querySelectorAll('.wheel-point')].find((g) => g.textContent?.includes('6°09'))!
    fireEvent.pointerDown(sun, { pointerType: 'touch', pointerId: 1 })
    fireEvent.pointerLeave(sun, { pointerType: 'touch', pointerId: 1 })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Your Mercury')
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
    const sun = [...container.querySelectorAll('.wheel-point')].find((g) => g.textContent?.includes('6°09'))!
    fireEvent.pointerEnter(sun, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip').className).toMatch(/above|below|left|right/)
    fireEvent.pointerLeave(sun, { pointerType: 'mouse' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it("shows the transit's reading in the popup once written, and says it is coming until then", () => {
    const readings = { 'Mercury|Conjunction|Pluto': 'Say the quiet thing out loud today.' }
    const { container, rerender } = render(<ToolCard name="create_transit_chart" output={transit} />)
    const line = container.querySelectorAll('.wheel-aspect')[0]!
    fireEvent.pointerEnter(line, { pointerType: 'mouse' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('A reading for this transit is on its way.')
    rerender(<ToolCard name="create_transit_chart" output={transit} readings={readings} />)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Say the quiet thing out loud today.')
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('on its way')
    fireEvent.pointerLeave(line, { pointerType: 'mouse' })
    // The planet's popup carries the reading under its aspect line.
    const mercury = [...container.querySelectorAll('.wheel-point')].find((g) => g.textContent?.includes('15°04'))!
    fireEvent.pointerEnter(mercury, { pointerType: 'mouse' })
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Transiting Mercury')
    expect(tip.querySelector('li .wheel-tip-reading')).toHaveTextContent('Say the quiet thing out loud today.')
  })
})
