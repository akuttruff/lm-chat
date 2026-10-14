import { describe, it, expect } from 'vitest'
import { KEY_ROWS, keyTransits, looksLikeForecast, parseForecast, periodText } from './forecastTable.ts'
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
    expect(t).toMatchObject({ horizon: 'week', start: '2026-10-14', end: '2026-10-20' })
    expect(t.rows.length).toBeGreaterThan(4)
    expect(t.rows[0]).toMatchObject({ from: 'Mars', to: 'Saturn', type: 'Square', exact: '2026-10-19 22:56', toHouse: 1, fromRetrograde: false, pass: null })
    const exact = t.rows.map((r) => Boolean(r.exact))
    expect(exact.indexOf(false)).toBeGreaterThan(0)
    expect(exact.slice(exact.indexOf(false))).not.toContain(true)
    expect(keyTransits(t)).toEqual(t.rows.slice(0, KEY_ROWS.week))
  })

  it('keeps only the top of a month and a year, in the tool\'s order', () => {
    const m = parseForecast(month)!
    expect(m.rows.length).toBeGreaterThan(KEY_ROWS.month)
    expect(keyTransits(m)).toHaveLength(KEY_ROWS.month)
    const weights = keyTransits(m).map((r) => r.weight)
    expect(weights).toEqual(weights.slice().sort((a, b) => b - a))
    const y = parseForecast(year)!
    expect(y.rows.length).toBeGreaterThan(KEY_ROWS.year)
    expect(keyTransits(y)).toHaveLength(KEY_ROWS.year)
    expect(y.rows.some((r) => r.pass && / of /.test(r.pass))).toBe(true)
    expect(y.rows.some((r) => r.fromRetrograde)).toBe(true)
  })

  it('names the period for the caption', () => {
    expect(periodText(parseForecast(week)!)).toBe('Oct 14–20')
    expect(periodText(parseForecast(month)!)).toBe('October 2026')
    expect(periodText(parseForecast(year)!)).toBe('Oct 14, 2026 – Oct 14, 2027')
    expect(periodText({ horizon: 'week', start: '2026-10-29', end: '2026-11-04', rows: [] })).toBe('Oct 29–Nov 4')
    expect(windowText('2026-10-28', '2026-11-03')).toBe('Oct 28–Nov 3')
    expect(windowText('2026-10-14', '2026-10-14')).toBe('Oct 14')
  })
})
