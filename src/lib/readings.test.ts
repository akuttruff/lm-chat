import { describe, it, expect } from 'vitest'
import { aspectKey, parseReadings, readingFor, readingsInput, readingsTokenCap } from './readings.ts'
import { parseWheel } from './chartWheel.ts'
import transit from '../test/fixtures/transit-chart.json?raw'
import natal from '../test/fixtures/natal-chart.json?raw'

describe('what the model is asked', () => {
  it('lists every aspect of a transit wheel by key, with both ends placed by sign and house', () => {
    const wheel = parseWheel(transit)!
    const input = readingsInput(wheel)!
    expect(input).toMatch(/^Day: 2026-10-13 05:58\. Birth chart of 1984-05-10 20:44\.\nTransits:\n/)
    expect(input).toContain('- key: Mercury|Sextile|MC\n  transiting Mercury in Scorpio, 12th house sextile natal Midheaven in Virgo; exact 2026-10-13 16:16, orb 0°23′, applying')
    expect(input).toContain('- key: Neptune|Sextile|Chiron\n  transiting Neptune in Aries, 5th house, retrograde sextile natal Chiron in Gemini, 7th house; orb 0°28′, applying')
    expect(input.split('\n- key: ').length - 1).toBe(wheel.aspects.length)
    expect(readingsTokenCap(wheel.aspects.length)).toBeGreaterThan(90 * wheel.aspects.length)
  })

  it('has nothing to ask about a birth chart alone', () => {
    expect(readingsInput(parseWheel(natal)!)).toBeNull()
  })
})

describe('what comes back', () => {
  const keys = ['Mercury|Sextile|MC', 'Jupiter|Square|Sun']

  it('reads the JSON object, fenced or chatted around, keeping only the keys asked for', () => {
    const text = 'Here you go:\n```json\n{"Mercury|Sextile|MC": "Say the quiet thing out loud today.", "Jupiter|Square|Sun": "  Too much, \\n too fast. ", "Moon|Trine|Venus": "not asked"}\n```'
    expect(parseReadings(text, keys)).toEqual({
      'Mercury|Sextile|MC': 'Say the quiet thing out loud today.',
      'Jupiter|Square|Sun': 'Too much, too fast.',
    })
  })

  it('gives nothing for an answer with no readings in it', () => {
    expect(parseReadings('I cannot do that.', keys)).toBeNull()
    expect(parseReadings('{"Mercury|Sextile|MC": 3}', keys)).toBeNull()
    expect(parseReadings('[1, 2]', keys)).toBeNull()
    expect(parseReadings('{"broken": ', keys)).toBeNull()
  })

  it('looks a reading up by its aspect', () => {
    const wheel = parseWheel(transit)!
    const a = wheel.aspects.find((x) => x.from === 'Mercury' && x.to === 'MC')!
    expect(aspectKey(a)).toBe('Mercury|Sextile|MC')
    expect(readingFor({ 'Mercury|Sextile|MC': 'Speak up.' }, a)).toBe('Speak up.')
    expect(readingFor({}, a)).toBeNull()
    expect(readingFor(undefined, a)).toBeNull()
  })
})
