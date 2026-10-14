import { describe, it, expect } from 'vitest'
import { parseWheel } from './chartWheel.ts'
import { activeTransits, dayText, orbText } from './transitTable.ts'
import transit from '../test/fixtures/transit-chart.json?raw'

describe('transits as rows', () => {
  it('lists a transit wheel\'s aspects in date order, with positions, houses, movement and retrograde state', () => {
    const rows = activeTransits(parseWheel(transit)!)
    expect(rows.length).toBeGreaterThan(3)
    const dated = rows.filter((r) => r.exact).map((r) => r.exact!)
    expect(dated.length).toBeGreaterThan(0)
    expect(dated).toEqual(dated.slice().sort())
    expect(rows.slice(dated.length).every((r) => !r.exact)).toBe(true) // the undated last, tightest first
    expect(rows.slice(dated.length).map((r) => r.orb)).toEqual(rows.slice(dated.length).map((r) => r.orb).sort((a, b) => a - b))
    const jupiter = rows.find((r) => r.from === 'Jupiter' && r.to === 'Sun')!
    expect(jupiter).toMatchObject({ type: 'Square', toHouse: 6, fromRetrograde: false, movement: 'separating', toPosition: '20°38′ Taurus' })
    // Jupiter's 2026-27 loop squares the Sun three times: this is the first.
    expect(jupiter).toMatchObject({ exact: '2026-10-06 16:36', pass: '1 of 3', passes: ['2026-10-06 16:36', '2027-02-21 10:07', '2027-06-02 09:19'] })
    expect(rows.every((r) => r.passes.includes(r.exact!) && (r.pass === null) === (r.passes.length === 1))).toBe(true)
    expect(jupiter.fromPosition).toMatch(/^2\d°\d\d′ Leo$/)
    expect(activeTransits({ ...parseWheel(transit)!, kind: 'natal' })).toEqual([])
  })

  it('writes orbs and days the way a table reads', () => {
    expect(orbText(1.283)).toBe('1°17′')
    expect(orbText(0)).toBe('0°00′')
    expect(dayText('2026-10-15 16:59')).toBe('Oct 15 16:59')
    expect(dayText('2026-10-15')).toBe('Oct 15')
    expect(dayText('whenever')).toBe('whenever')
    // Against the table's own date: the year only when it differs.
    expect(dayText('2025-12-07 16:36', '2026-10-14 10:06')).toBe('Dec 7, 2025 16:36')
    expect(dayText('2027-06-11 08:19', '2026-10-14')).toBe('Jun 11, 2027 08:19')
    expect(dayText('2026-11-01 16:51', '2026-10-14 10:06')).toBe('Nov 1 16:51')
    expect(dayText('2026-11-01', null)).toBe('Nov 1')
  })
})
