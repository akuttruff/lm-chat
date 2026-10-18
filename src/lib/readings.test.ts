import { describe, it, expect } from 'vitest'
import { aspectKey, parseReadings, readingFor, readingsInput, readingsTokenCap } from './readings.ts'
import { parseWheel } from './chartWheel.ts'
import transit from '../test/fixtures/transit-chart.json?raw'
import natal from '../test/fixtures/natal-chart.json?raw'

describe('what the model is asked', () => {
  it('lists every aspect of a transit wheel by key, with both ends placed by sign and house', () => {
    const wheel = parseWheel(transit)!
    const input = readingsInput(wheel)!
    expect(input).toMatch(/^Day: 2026-10-13 05:58\. Birth chart of 1990-06-15 14:30\.\nTransits:\n/)
    expect(input).toContain('- key: Mercury|Trine|MC\n  transiting Mercury in Scorpio, 2nd house trine natal Midheaven in Cancer; exact 2026-10-14 04:42, pass 1 of 3 (also 2026-11-01 10:33, 2026-11-26 10:03), orb 0°52′, applying')
    // A retrograde's whole run goes to the model, so a reading can say the contact returns.
    expect(input).toContain('- key: Uranus|Conjunction|Mercury\n  transiting Uranus in Gemini, 9th house, retrograde conjunction natal Mercury in Gemini, 9th house; exact 2027-06-02 20:31, pass 1 of 3 (also 2028-01-20 22:13, 2028-03-06 09:01), orb 0°54′, separating')
    expect(input.split('\n- key: ').length - 1).toBe(wheel.aspects.length)
    expect(readingsTokenCap(wheel.aspects.length)).toBeGreaterThan(90 * wheel.aspects.length)
  })

  it('has nothing to ask about a birth chart alone', () => {
    expect(readingsInput(parseWheel(natal)!)).toBeNull()
  })
})

describe('what comes back', () => {
  const keys = ['Mercury|Trine|MC', 'Saturn|Conjunction|Mars']

  it('reads the JSON object, fenced or chatted around, keeping only the keys asked for', () => {
    const text = 'Here you go:\n```json\n{"Mercury|Trine|MC": "Say the quiet thing out loud today.", "Saturn|Conjunction|Mars": "  Too much, \\n too fast. ", "Moon|Trine|Venus": "not asked"}\n```'
    expect(parseReadings(text, keys)).toEqual({
      'Mercury|Trine|MC': 'Say the quiet thing out loud today.',
      'Saturn|Conjunction|Mars': 'Too much, too fast.',
    })
  })

  it('gives nothing for an answer with no readings in it', () => {
    expect(parseReadings('I cannot do that.', keys)).toBeNull()
    expect(parseReadings('{"Mercury|Trine|MC": 3}', keys)).toBeNull()
    expect(parseReadings('[1, 2]', keys)).toBeNull()
    expect(parseReadings('{"broken": ', keys)).toBeNull()
  })

  it('looks a reading up by its aspect', () => {
    const wheel = parseWheel(transit)!
    const a = wheel.aspects.find((x) => x.from === 'Mercury' && x.to === 'MC')!
    expect(aspectKey(a)).toBe('Mercury|Trine|MC')
    expect(readingFor({ 'Mercury|Trine|MC': 'Speak up.' }, a)).toBe('Speak up.')
    expect(readingFor({}, a)).toBeNull()
    expect(readingFor(undefined, a)).toBeNull()
  })
})
