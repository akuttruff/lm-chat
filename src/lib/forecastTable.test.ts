import { describe, it, expect } from 'vitest'
import { KEY_WEIGHT, keyTransits, looksLikeForecast, parseForecast, periodText } from './forecastTable.ts'
import { windowText } from './transitTable.ts'
import week from '../test/fixtures/forecast-week.json?raw'
import month from '../test/fixtures/forecast-month.json?raw'
import year from '../test/fixtures/forecast-year.json?raw'
import transit from '../test/fixtures/transit-chart.json?raw'

describe('a forecast as rows', () => {
  it('tells a forecast from a chart or anything else', () => {
    expect(looksLikeForecast(week)).toBe(true)
    expect(looksLikeForecast(transit)).toBe(false)
    expect(parseForecast('not json')).toBeNull()
    expect(parseForecast('{"forecast": "decade", "range": {"start": "2026-01-01", "end": "2036-01-01"}, "headline_transits": []}')).toBeNull()
    expect(parseForecast('{"forecast": "week", "headline_transits": []}')).toBeNull()
  })

  it('reads the week with its exact contacts first, both ends, houses and the retrograde flag', () => {
    const t = parseForecast(week)!
    expect(t).toMatchObject({ horizon: 'week', start: '2026-10-12', end: '2026-10-18' })
    expect(t.rows.length).toBeGreaterThan(4)
    expect(t.rows[0]).toMatchObject({ from: 'Mars', to: 'Venus', type: 'Square', exact: '2026-10-17 05:04', toHouse: 6, fromRetrograde: false, pass: null, passes: ['2026-10-17 05:04'], fromPosition: '11°01′ Leo', toPosition: '11°01′ Taurus', movement: null })
    // The slow planets' contacts are runs: every pass of each, with the one nearest the week among them.
    const runs = t.rows.filter((r) => r.pass)
    expect(runs.length).toBeGreaterThan(2)
    expect(runs.every((r) => r.passes.length >= 2 && r.passes.includes(r.nearestExact!) && r.pass!.endsWith(`of ${r.passes.length}`))).toBe(true)
    expect(runs.find((r) => r.from === 'Jupiter' && r.to === 'Sun')).toMatchObject({ pass: '1 of 3', passes: ['2026-10-06 16:36', '2027-02-21 10:07', '2027-06-02 09:19'] })
    const exact = t.rows.map((r) => Boolean(r.exact))
    expect(exact.indexOf(false)).toBeGreaterThan(0)
    expect(exact.slice(exact.indexOf(false))).not.toContain(true)
    expect(new Set(keyTransits(t))).toEqual(new Set(t.rows.filter((r) => r.weight >= KEY_WEIGHT.week)))
    // In date order: the exact moment, or the first day in orb; the weightier first on the same moment.
    const moments = keyTransits(t).map((r) => r.exact ?? r.start)
    expect(moments).toEqual(moments.slice().sort())
    expect(keyTransits(t).at(-1)).toMatchObject({ from: 'Mars', to: 'Venus', exact: '2026-10-17 05:04' })
    // The week's events make the table: Mars, the Sun and Venus do, Mercury not unless on a key point.
    expect(keyTransits(t).some((r) => r.from === 'Mars' && r.exact)).toBe(true)
    const mercury = { ...t.rows[0]!, from: 'Mercury', weight: 0.5 }
    expect(keyTransits({ ...t, rows: [mercury, { ...mercury, weight: 1 }] })).toEqual([{ ...mercury, weight: 1 }])
  })

  it('keeps the weighty contacts of a month and a year, in the tool\'s order', () => {
    const m = parseForecast(month)!
    const keyM = keyTransits(m)
    expect(keyM.length).toBeGreaterThan(0)
    expect(keyM.length).toBeLessThan(m.rows.length)
    expect(keyM.every((r) => r.weight >= KEY_WEIGHT.month)).toBe(true)
    expect(m.rows.filter((r) => r.weight < KEY_WEIGHT.month).length).toBe(m.rows.length - keyM.length)
    // The month's bar is the slow planets: Mars alone never reaches it.
    expect(keyM.some((r) => r.from === 'Mars')).toBe(false)
    const moments = keyM.map((r) => r.exact ?? r.start)
    expect(moments).toEqual(moments.slice().sort())
    const y = parseForecast(year)!
    expect(keyTransits(y).length).toBeLessThanOrEqual(y.rows.length) // a year's headlines are all slow planets, so all may be key
    expect(keyTransits({ ...y, rows: y.rows.map((r) => ({ ...r, weight: 2.9 })) })).toEqual([])
    expect(y.rows.some((r) => r.pass && / of /.test(r.pass))).toBe(true)
    expect(y.rows.some((r) => r.fromRetrograde)).toBe(true)
  })

  it('says when a contact in orb all period actually perfects, before or after it', () => {
    const t = parseForecast(week)!
    const backdrop = t.rows.filter((r) => !r.exact)
    expect(backdrop.length).toBeGreaterThan(0)
    expect(backdrop.some((r) => r.nearestExact)).toBe(true)
    for (const r of backdrop) if (r.nearestExact) expect(r.nearestExact < t.start || r.nearestExact > t.end).toBe(true)
    for (const r of t.rows) if (r.exact) expect(r.nearestExact).toBe(r.exact)
    // Which way the backdrop is going across the week.
    expect(backdrop.every((r) => r.movement === 'applying' || r.movement === 'separating')).toBe(true)
    expect(backdrop.some((r) => r.movement === 'applying') && backdrop.some((r) => r.movement === 'separating')).toBe(true)
    expect(parseForecast('{"forecast":"week","range":{"start":"2026-10-12","end":"2026-10-18"},"headline_transits":[{"transiting":"Pluto","natal":"Sun","aspect":"Square","start":"2026-10-12","end":"2026-10-18"}]}')!.rows[0])
      .toMatchObject({ exact: null, nearestExact: null })
  })

  it('names the period for the caption', () => {
    expect(periodText(parseForecast(week)!)).toBe('Oct 12–18')
    expect(periodText(parseForecast(month)!)).toBe('October 2026')
    expect(periodText(parseForecast(year)!)).toBe('Oct 14, 2026 – Oct 14, 2027')
    expect(periodText({ horizon: 'week', start: '2026-10-29', end: '2026-11-04', rows: [] })).toBe('Oct 29–Nov 4')
    expect(windowText('2026-10-28', '2026-11-03')).toBe('Oct 28–Nov 3')
    expect(windowText('2026-10-14', '2026-10-14')).toBe('Oct 14')
  })
})
