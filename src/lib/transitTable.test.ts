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
    expect(jupiter.fromPosition).toMatch(/^2\d°\d\d′ Leo$/)
    expect(activeTransits({ ...parseWheel(transit)!, kind: 'natal' })).toEqual([])
  })

  it('writes orbs and days the way a table reads', () => {
    expect(orbText(1.283)).toBe('1°17′')
    expect(orbText(0)).toBe('0°00′')
    expect(dayText('2026-10-15 16:59')).toBe('Oct 15 16:59')
    expect(dayText('2026-10-15')).toBe('Oct 15')
    expect(dayText('whenever')).toBe('whenever')
  })
})
