import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ActiveTransits, BACKDROP_SHOWN, ForecastTransits } from './TransitTable'
import { parseWheel } from '../lib/chartWheel.ts'
import { activeTransits, orbText } from '../lib/transitTable.ts'
import { sortRows } from '../lib/sortRows.ts'
import { parseForecast } from '../lib/forecastTable.ts'
import { fullMonth, fullWeek } from '../lib/forecastTable.test.ts'
import transit from '../test/fixtures/transit-chart.json?raw'

const wheel = parseWheel(transit)!
const rows = activeTransits(wheel)
const orbs = () => screen.getAllByText(/^orb /).map((el) => el.textContent)

describe('ActiveTransits', () => {
  it('is four plain columns unless asked for weights and sorting', () => {
    render(<ActiveTransits wheel={wheel} />)
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['When', 'Transit', 'Aspect', 'Natal'])
    expect(screen.queryByRole('button')).toBeNull()
    expect(within(screen.getAllByRole('row')[1]!).getAllByRole('cell')).toHaveLength(4)
    expect(orbs()).toHaveLength(rows.length)
  })

  it('sorts by a column on a click, the other way on another, and back to its own order on a third or from the caption', async () => {
    const user = userEvent.setup()
    render(<ActiveTransits wheel={wheel} weights sortable />)
    const own = orbs()
    expect(own).toHaveLength(rows.length)

    const aspect = screen.getByRole('button', { name: 'Aspect' })
    await user.click(aspect)
    expect(screen.getByRole('columnheader', { name: /^Aspect/ })).toHaveAttribute('aria-sort', 'ascending')
    const up = orbs()
    expect(up).toEqual(sortRows(rows, { key: 'orb', dir: 'asc' }).map((r) => `orb ${orbText(r.orb)}`))
    expect(up).not.toEqual(own)

    await user.click(screen.getByRole('button', { name: /^Aspect/ }))
    expect(screen.getByRole('columnheader', { name: /^Aspect/ })).toHaveAttribute('aria-sort', 'descending')
    expect(orbs()).toEqual([...up].reverse())

    await user.click(screen.getByRole('button', { name: /^Aspect/ }))
    expect(screen.getByRole('columnheader', { name: /^Aspect/ })).toHaveAttribute('aria-sort', 'none')
    expect(orbs()).toEqual(own)

    await user.click(screen.getByRole('button', { name: 'Transit' }))
    const cells = within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[1]!.textContent!)
    const byPlanet = sortRows(rows, { key: 'from', dir: 'asc' }).map((r) => r.from)
    cells.forEach((text, i) => expect(text).toContain(byPlanet[i]))
    await user.click(screen.getByRole('button', { name: 'default order' }))
    expect(orbs()).toEqual(own)
  })

  it('shows each transit\'s weight and sorts by it, the heaviest first on a second click', async () => {
    const user = userEvent.setup()
    render(<ActiveTransits wheel={wheel} weights sortable />)
    const weights = () => within(screen.getByRole('table')).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[4]!.childNodes[0]!.textContent!)
    expect(weights()).toEqual(rows.map((r) => (r.weight === null ? '—' : String(r.weight))))
    expect(screen.getByRole('button', { name: 'Weight' })).toHaveAccessibleDescription(/weight = slowness × aspect, doubled on a key point/)
    expect(screen.getByText(/^Mercury 0.5 × trine 0.7 × 2 on the (MC|Midheaven) = 0.7$/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Weight' }))
    await user.click(screen.getByRole('button', { name: /^Weight/ }))
    expect(screen.getByRole('columnheader', { name: /Weight/ })).toHaveAttribute('aria-sort', 'descending')
    const shown = weights().filter((w) => w !== '—').map(Number)
    expect(shown).toEqual([...shown].sort((a, b) => b - a))
    expect(shown[0]).toBe(Math.max(...rows.map((r) => r.weight ?? 0)))
  })
})

describe('ForecastTransits', () => {
  it('keeps a scanned week to four plain columns unless asked, its group headings spanning them', () => {
    render(<ForecastTransits table={parseForecast(fullWeek)!} />)
    expect(screen.getAllByRole('columnheader').filter((th) => th.closest('thead')).map((th) => th.textContent)).toEqual(['When', 'Transit', 'Aspect', 'Natal'])
    expect(screen.getByText('Exact this week · 3')).toHaveAttribute('colspan', '4')
    expect(screen.queryByRole('button', { name: 'Weight' })).toBeNull()
  })

  it('shows a scanned week in its two groups, folds the backdrop, and flattens for a sort', async () => {
    const user = userEvent.setup()
    const table = parseForecast(fullWeek)!
    render(<ForecastTransits table={table} weights sortable />)
    expect(screen.getByText(/^Transits in orb · Oct 18–24/)).toBeInTheDocument()
    const heads = () => screen.getAllByRole('rowgroup').map((g) => g.textContent)
    expect(screen.getByText('Exact this week · 3')).toBeInTheDocument()
    expect(screen.getByText('In orb all week, not exact in it · 7')).toBeInTheDocument()
    const dataRows = () => screen.getAllByRole('row').filter((r) => r.querySelector('td.tt-when'))
    expect(dataRows()).toHaveLength(3 + BACKDROP_SHOWN)
    await user.click(screen.getByRole('button', { name: `Show ${7 - BACKDROP_SHOWN} more` }))
    expect(dataRows()).toHaveLength(10)
    expect(heads()[2]).toContain('Uranus')

    // A sort runs over every row at once; the table's own order brings the groups back.
    await user.click(screen.getByRole('button', { name: 'Weight' }))
    await user.click(screen.getByRole('button', { name: /^Weight/ }))
    expect(screen.queryByText('Exact this week · 3')).not.toBeInTheDocument()
    expect(dataRows()).toHaveLength(10)
    expect(dataRows()[0]!.textContent).toMatch(/Saturn|Uranus/)
    await user.click(screen.getByRole('button', { name: 'default order' }))
    expect(screen.getByText('Exact this week · 3')).toBeInTheDocument()
  })

  it('names a month\'s groups for the month', async () => {
    const user = userEvent.setup()
    render(<ForecastTransits table={parseForecast(fullMonth)!} weights sortable />)
    expect(screen.getByText(/^Transits in orb · October 2026/)).toBeInTheDocument()
    expect(screen.getByText('Exact this month · 6')).toBeInTheDocument()
    expect(screen.getByText('In orb all month, not exact in it · 6')).toBeInTheDocument()
    const dataRows = () => screen.getAllByRole('row').filter((r) => r.querySelector('td.tt-when'))
    expect(dataRows()).toHaveLength(6 + BACKDROP_SHOWN)
    expect(dataRows()[0]!.textContent).toContain('Saturn')
    await user.click(screen.getByRole('button', { name: `Show ${6 - BACKDROP_SHOWN} more` }))
    expect(dataRows()).toHaveLength(12)
  })
})
