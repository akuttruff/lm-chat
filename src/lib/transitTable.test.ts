import { describe, it, expect } from 'vitest'
import { parseWheel } from './chartWheel.ts'
import { activeTransits, dayText, orbText } from './transitTable.ts'
import transit from '../test/fixtures/transit-chart.json?raw'

describe('transits as rows', () => {
  it('lists a transit wheel\'s aspects tightest first, with the houses and retrograde state of each end', () => {
    const rows = activeTransits(parseWheel(transit)!)
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.map((r) => r.orb)).toEqual([...rows.map((r) => r.orb)].sort((a, b) => a - b))
    const jupiter = rows.find((r) => r.from === 'Jupiter' && r.to === 'Sun')!
    expect(jupiter).toMatchObject({ type: 'Square', toHouse: 6, fromRetrograde: false, movement: 'separating' })
    expect(rows.some((r) => r.exact)).toBe(true)
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
