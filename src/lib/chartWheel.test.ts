import { describe, it, expect } from 'vitest'
import {
  aspectDetail, aspectFamily, aspectSentence, aspectsOfPoint, describePoint, elementOf, looksLikeChart, parseWheel, polar,
  screenAngle, signDegrees, spread, aspectGlyph, hasRetrograde} from './chartWheel.ts'
// The astro server's own output for one birth chart and one transit moment, as text, the way a tool card gets it.
import transit from '../test/fixtures/transit-chart.json?raw'
import natal from '../test/fixtures/natal-chart.json?raw'

describe('parseWheel', () => {
  it('reads a transit chart as a bi-wheel: natal inside, transits outside', () => {
    const w = parseWheel(transit)!
    expect(w.kind).toBe('transit')
    expect(w.dateTime).toBe('2026-10-13 05:58')
    expect(w.natalDateTime).toBe('1990-06-15 14:30')
    expect(w.inner.find((p) => p.name === 'Sun')!.longitude).toBeCloseTo(84.3882)
    expect(w.outer.find((p) => p.name === 'Sun')!.longitude).toBeCloseTo(200.0871)
    expect(w.angles.Asc).toBeCloseTo(193.6954)
    expect(w.angles.MC).toBeCloseTo(105.9221)
  })

  it('keeps the twelve cusps in house order', () => {
    const w = parseWheel(transit)!
    expect(w.cusps).toHaveLength(12)
    expect(w.cusps[0]).toBe(180)
    expect(w.cusps[9]).toBe(90)
  })

  it('carries every aspect with the transiting body first', () => {
    const w = parseWheel(transit)!
    expect(w.aspects.length).toBeGreaterThan(0)
    const mercuryPluto = w.aspects.find((a) => a.from === 'Mercury' && a.to === 'Pluto')!
    expect(mercuryPluto.type).toBe('Conjunction')
    expect(mercuryPluto.orb).toBeCloseTo(0.34)
    // Aspects to the angles are kept: the wheel knows where they are.
    expect(w.aspects.some((a) => a.to === 'MC')).toBe(true)
  })

  it('takes a retrograde flag the record spells out, with or without a speed', () => {
    const data = JSON.parse(transit) as { objects: Record<string, Record<string, unknown>> }
    data.objects.Sun = { ...data.objects.Sun, retrograde: true }
    delete data.objects.Sun.speed
    const w = parseWheel(JSON.stringify(data))!
    expect(w.outer.find((p) => p.name === 'Sun')!.retrograde).toBe(true)
    expect(hasRetrograde(w)).toBe(true)
  })

  it('marks a transiting planet retrograde from its speed', () => {
    const w = parseWheel(transit)!
    expect(w.outer.find((p) => p.name === 'Saturn')!.retrograde).toBe(true)
    expect(w.outer.find((p) => p.name === 'Sun')!.retrograde).toBe(false)
  })

  it('reads a natal chart as a single wheel with its own aspects', () => {
    const w = parseWheel(natal)!
    expect(w.kind).toBe('natal')
    expect(w.outer).toEqual([])
    expect(w.natalDateTime).toBeNull()
    expect(w.inner.map((p) => p.name)).toContain('Chiron')
    expect(w.inner.find((p) => p.name === 'Saturn')!.retrograde).toBe(true)
    expect(w.aspects.length).toBeGreaterThan(0)
  })

  it('leaves out points it has no glyph for', () => {
    const w = parseWheel(transit)!
    expect(w.inner.map((p) => p.name)).not.toContain('Vertex')
    expect(w.outer.map((p) => p.name)).not.toContain('Part of Fortune')
  })

  it('is null for anything that is not a chart', () => {
    expect(parseWheel('plain text')).toBeNull()
    expect(parseWheel('{"objects": {}, "houses": {}}')).toBeNull()
    expect(parseWheel('{"objects": {"Sun": {"longitude": 1}}, "houses": {"1": {"cusp": 0}}}')).toBeNull()
    expect(parseWheel('{not json')).toBeNull()
  })

  it('needs an Ascendant to turn the wheel by', () => {
    const data = JSON.parse(natal)
    delete data.objects.Asc
    expect(parseWheel(JSON.stringify(data))).toBeNull()
  })
})

describe('looksLikeChart', () => {
  it('spots a chart without parsing it', () => {
    expect(looksLikeChart(transit)).toBe(true)
    expect(looksLikeChart('{"spans": []}')).toBe(false)
  })
})

describe('geometry', () => {
  it('puts the Ascendant at nine o\'clock and runs the zodiac counter-clockwise', () => {
    const asc = 243.78
    const [ax, ay] = polar(300, 300, 100, screenAngle(asc, asc))
    expect(ax).toBeCloseTo(200)
    expect(ay).toBeCloseTo(300)
    // Ninety degrees on from the Ascendant is the bottom of the wheel.
    const [bx, by] = polar(300, 300, 100, screenAngle(asc + 90, asc))
    expect(bx).toBeCloseTo(300)
    expect(by).toBeCloseTo(400)
  })

  it('reads degrees and minutes within the sign', () => {
    expect(signDegrees(50.6369)).toEqual({ sign: 1, deg: 20, min: 38 })
    expect(signDegrees(359.9999)).toEqual({ sign: 11, deg: 30, min: 0 })
  })

  it('colours signs by element round the wheel', () => {
    expect([0, 1, 2, 3, 4, 11].map(elementOf)).toEqual(['fire', 'earth', 'air', 'water', 'fire', 'water'])
  })

  it('groups aspects into how they are drawn', () => {
    expect(aspectFamily('Square')).toBe('hard')
    expect(aspectFamily('opposition')).toBe('hard')
    expect(aspectFamily('Trine')).toBe('soft')
    expect(aspectFamily('Conjunction')).toBe('conjunction')
    expect(aspectFamily('Quincunx')).toBe('minor')
  })
})

describe('spread', () => {
  const gaps = (lons: number[]): number[] => {
    const s = [...lons].sort((a, b) => a - b)
    return s.map((v, i) => (i === s.length - 1 ? s[0]! + 360 - v : s[i + 1]! - v))
  }

  it('leaves well-separated glyphs where they are', () => {
    expect(spread([10, 100, 200, 300], 6)).toEqual([10, 100, 200, 300])
  })

  it('pushes a cluster apart until nothing overlaps, keeping its centre', () => {
    const out = spread([100, 101, 102], 6)
    expect(Math.min(...gaps(out))).toBeGreaterThanOrEqual(6 - 1e-6)
    expect(out[1]).toBeCloseTo(101)
    expect(out[0]).toBeLessThan(out[1]!)
    expect(out[2]).toBeGreaterThan(out[1]!)
  })

  it('handles a cluster that straddles zero degrees', () => {
    const out = spread([358, 359.5, 1], 6)
    expect(Math.min(...gaps(out))).toBeGreaterThanOrEqual(6 - 1e-6)
  })

  it('returns results in the order given', () => {
    const out = spread([200, 50, 51], 6)
    expect(out[0]).toBe(200)
    expect(out[1]).toBeLessThan(out[2]!)
  })
})

describe('in words', () => {
  it('says what a transit aspect is, as an astrologer would', () => {
    const w = parseWheel(transit)!
    const saturnMars = w.aspects.find((a) => a.from === 'Saturn' && a.to === 'Mars')!
    expect(aspectSentence(w, saturnMars)).toBe('Saturn in Aries conjunct your Mars in Aries')
    const marsNode = w.aspects.find((a) => a.from === 'Mars' && a.to === 'True North Node')!
    expect(aspectSentence(w, marsNode)).toBe('Mars in Leo opposing your North Node in Aquarius')
    const mercuryMC = w.aspects.find((a) => a.from === 'Mercury' && a.to === 'MC')!
    expect(aspectSentence(w, mercuryMC)).toBe('Mercury in Scorpio trine your Midheaven in Cancer')
  })

  it('says what a natal aspect is, without "your"', () => {
    const w = parseWheel(natal)!
    const a = w.aspects.find((x) => x.type === 'Square')!
    expect(aspectSentence(w, a)).toMatch(/^\w[\w ]* in \w+ squaring \w[\w ]* in \w+$/)
    // Aspects to points the wheel doesn't draw are left out altogether.
    expect(w.aspects.some((x) => x.to === 'Part of Fortune' || x.from === 'Part of Fortune')).toBe(false)
  })

  it('gives the orb, direction and exact moment when known', () => {
    const w = parseWheel(transit)!
    const a = w.aspects.find((x) => x.from === 'Mercury' && x.to === 'MC')!
    expect(aspectDetail(a)).toBe('exact 2026-10-14 04:42, pass 1 of 3 (also 2026-11-01 10:33, 2026-11-26 10:03), orb 0°52′, applying')
    expect(aspectDetail({ ...a, movement: null, exactAt: null, pass: null, passes: [] })).toBe('orb 0°52′')
    expect(aspectDetail({ ...a, movement: null, pass: null, passes: [a.exactAt!] })).toBe('exact 2026-10-14 04:42, orb 0°52′')
  })

  it('describes a planet with its position, house and aspects', () => {
    const w = parseWheel(transit)!
    const mercury = describePoint(w, 'inner', w.inner.find((p) => p.name === 'Mercury')!)
    expect(mercury.title).toBe('Your Mercury')
    expect(mercury.position).toBe('6°09′ Gemini · 9th house')
    expect(mercury.aspects).toContain('Uranus in Gemini conjunct your Mercury in Gemini')
    const saturn = describePoint(w, 'outer', w.outer.find((p) => p.name === 'Saturn')!)
    expect(saturn.title).toBe('Transiting Saturn')
    expect(saturn.position).toBe('10°36′ Aries · 7th house · ℞ retrograde')
    expect(saturn.aspects).toEqual(['Saturn in Aries conjunct your Mars in Aries'])
    const sun = describePoint(w, 'inner', w.inner.find((p) => p.name === 'Sun')!)
    expect(sun.position).toBe('24°23′ Gemini · 9th house')
    expect(sun.aspects).toEqual([])
  })

  it('finds a point\'s aspects on the right ring only', () => {
    const w = parseWheel(transit)!
    // Transiting Mercury makes five contacts; natal Mercury receives one, from Uranus. Each ring finds only its own.
    expect(aspectsOfPoint(w, 'outer', 'Mercury').map((i) => w.aspects[i]!.to)).toEqual(['Pluto', 'MC', 'Jupiter', 'Chiron', 'Neptune'])
    expect(aspectsOfPoint(w, 'inner', 'Mercury').map((i) => w.aspects[i]!.from)).toEqual(['Uranus'])
  })
})

describe('aspectGlyph', () => {
  it('gives each aspect its standard symbol, whatever the casing, and nothing for one it does not know', () => {
    expect(aspectGlyph('Conjunction')).toBe('\u260c')
    expect(aspectGlyph('opposition')).toBe('\u260d')
    expect(aspectGlyph('SQUARE')).toBe('\u25a1')
    expect(aspectGlyph('trine')).toBe('\u25b3')
    expect(aspectGlyph('Sextile')).toBe('\u26b9')
    expect(aspectGlyph('quincunx')).toBe('\u26bb')
    expect(aspectGlyph('semi-sextile')).toBe('\u26ba')
    expect(aspectGlyph('mystery')).toBe('')
  })
})
