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
    const saturn = rows.find((r) => r.from === 'Saturn' && r.to === 'Mars')!
    expect(saturn).toMatchObject({ type: 'Conjunction', toHouse: 7, fromRetrograde: true, movement: 'separating', toPosition: '11°14′ Aries' })
    // Saturn 4 times a conjunction: the forecasts' own weight. Mercury 0.5 is doubled on the MC; a trine is 0.7 of it.
    expect(saturn.weight).toBe(4)
    expect(rows.find((r) => r.from === 'Mercury' && r.to === 'MC')!.weight).toBe(0.7)
    expect(rows.find((r) => r.from === 'Mercury' && r.to === 'Jupiter')!.weight).toBe(0.35)
    // Saturn's 2026-27 loop crosses Mars three times: this is the second.
    expect(saturn).toMatchObject({ exact: '2026-10-05 04:39', pass: '2 of 3', passes: ['2026-05-20 16:45', '2026-10-05 04:39', '2027-02-11 08:30'] })
    expect(rows.every((r) => r.passes.includes(r.exact!) && (r.pass === null) === (r.passes.length === 1))).toBe(true)
    expect(saturn.fromPosition).toBe('10°36′ Aries')
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
