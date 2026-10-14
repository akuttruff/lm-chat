import { describe, it, expect } from 'vitest'
import { parseWheel } from './chartWheel.ts'
import { activeTransits, dayText, looksLikeUpcoming, orbText, parseUpcoming, windowText } from './transitTable.ts'
import transit from '../test/fixtures/transit-chart.json?raw'
import upcoming from '../test/fixtures/upcoming-transits.json?raw'

describe('upcoming transits as rows', () => {
  it('tells an upcoming-transits result from a chart or anything else', () => {
    expect(looksLikeUpcoming(upcoming)).toBe(true)
    expect(looksLikeUpcoming(transit)).toBe(false)
    expect(looksLikeUpcoming('{"spans": []}')).toBe(false)
    expect(parseUpcoming('not json')).toBeNull()
    expect(parseUpcoming('{"transit_range": {"start": "2026-10-14"}, "transits": []}')).toBeNull()
  })

  it('reads every span with both ends, its window, its exact moment and the retrograde flag', () => {
    const t = parseUpcoming(upcoming)!
    expect(t).toMatchObject({ start: '2026-10-14', end: '2026-10-14', mode: 'natal', omitted: null })
    expect(t.rows).toHaveLength(17)
    expect(t.rows[0]).toMatchObject({ from: 'Chiron', to: 'Mercury', type: 'Conjunction', fromRetrograde: true, toHouse: 5, orb: 1.4, exact: null, start: '2026-10-14', end: '2026-10-14' })
    expect(t.rows.some((r) => r.exact)).toBe(true)
  })

  it('rebuilds rows from the positional form an oversized result comes in', () => {
    const data = JSON.parse(upcoming) as { transits: Record<string, unknown>[]; span_fields?: string[] }
    const fields = ['start', 'end', 'from_object', 'to_object', 'type', 'orb', 'exact', 'from_position', 'from_house', 'to_house', 'from_retrograde']
    const packed = { ...data, span_fields: fields, transits: data.transits.map((s) => fields.map((f) => s[f])), omitted: { note: 'Moon spans left out to fit.' } }
    const t = parseUpcoming(JSON.stringify(packed))!
    expect(t.rows).toHaveLength(17)
    expect(t.rows[0]).toMatchObject({ from: 'Chiron', to: 'Mercury', type: 'Conjunction', fromRetrograde: true, toHouse: 5 })
    expect(t.omitted).toBe('Moon spans left out to fit.')
  })

  it('lists a transit wheel\'s aspects tightest first, with the houses and retrograde state of each end', () => {
    const rows = activeTransits(parseWheel(transit)!)
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.map((r) => r.orb)).toEqual([...rows.map((r) => r.orb)].sort((a, b) => a - b))
    const jupiter = rows.find((r) => r.from === 'Jupiter' && r.to === 'Sun')!
    expect(jupiter).toMatchObject({ type: 'Square', toHouse: 6, fromRetrograde: false, movement: 'separating' })
    expect(rows.some((r) => r.exact)).toBe(true)
    expect(activeTransits({ ...parseWheel(transit)!, kind: 'natal' })).toEqual([])
  })

  it('writes orbs, days and windows the way a table reads', () => {
    expect(orbText(1.283)).toBe('1°17′')
    expect(orbText(0)).toBe('0°00′')
    expect(dayText('2026-10-15 16:59')).toBe('Oct 15 16:59')
    expect(dayText('2026-10-15')).toBe('Oct 15')
    expect(dayText('whenever')).toBe('whenever')
    expect(windowText('2026-10-14', '2026-10-14')).toBe('Oct 14')
    expect(windowText('2026-10-14', '2026-10-16')).toBe('Oct 14–16')
    expect(windowText('2026-10-28', '2026-11-03')).toBe('Oct 28–Nov 3')
    expect(windowText(null, null)).toBe('')
  })
})
