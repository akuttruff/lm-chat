import { describe, it, expect } from 'vitest'
import { MAX_PIECE_CHARS, VOICES, isVoice, speechChunks, speechText, speedOf } from './speech.ts'

describe('speechText', () => {
  it('drops formatting marks and keeps the words', () => {
    expect(speechText('## Your week\n\n**Mars** enters your _seventh_ house. Try `journaling`.'))
      .toBe('Your week.\n\nMars enters your seventh house. Try journaling.')
  })

  it('reads lists and quotes as plain lines', () => {
    expect(speechText('- one\n- two\n1. three\n> a quote\n- [x] done')).toBe('one\ntwo\nthree\na quote\ndone')
  })

  it('names a code block once instead of reading it out', () => {
    const md = 'Run this:\n\n```sh\nnpm install\nnpm run build\n```\n\nThen reload.'
    expect(speechText(md)).toBe('Run this:\n\n(There is a code block here.)\n\nThen reload.')
  })

  it('says a link by its text, and a bare address as "a link"', () => {
    expect(speechText('See [the docs](https://example.com/a_(b)) or https://example.com/x.'))
      .toBe('See the docs or a link')
  })

  it('reads a table row by row, without its rule', () => {
    expect(speechText('| Day | Sign |\n| --- | :-: |\n| Monday | Leo |')).toBe('Day, Sign.\nMonday, Leo.')
  })

  it("leaves a heading that ends in a colon or question as it is, without a full stop after", () => {
    expect(speechText('# What now?\n## Steps:')).toBe('What now?\nSteps:')
  })

  it('removes images and HTML', () => {
    expect(speechText('A chart: ![chart](x.png) <br/>done')).toBe('A chart: done')
  })
})

describe('speechChunks', () => {
  const sentence = (n: number) => `This is sentence number ${n}, which runs on for a while to fill some space.`

  it('starts with a short piece so the voice begins at once, then longer ones', () => {
    const text = Array.from({ length: 30 }, (_, i) => sentence(i + 1)).join(' ')
    const chunks = speechChunks(text)
    expect(chunks[0]!.length).toBeLessThanOrEqual(180)
    expect(chunks.slice(1, -1).every((c) => c.length > 180 && c.length <= 600)).toBe(true)
    expect(chunks.join(' ')).toBe(text) // nothing lost, nothing repeated
  })

  it('breaks only between sentences', () => {
    const chunks = speechChunks(Array.from({ length: 12 }, (_, i) => sentence(i)).join(' '))
    expect(chunks.every((c) => c.endsWith('.'))).toBe(true)
  })

  it('cuts a sentence too long for one piece at a comma or space', () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(', ') + '.'
    const chunks = speechChunks(long)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 600)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })

  it('never makes a piece the server would refuse', () => {
    const chunks = speechChunks('x'.repeat(5000))
    expect(chunks.every((c) => c.length <= MAX_PIECE_CHARS)).toBe(true)
  })

  it('has nothing to say for an empty reply', () => {
    expect(speechChunks(speechText('```\ncode only\n```').replace(/\(There is a code block here\.\)/, ''))).toEqual([])
    expect(speechChunks('')).toEqual([])
  })
})

describe('voices and speed', () => {
  it('knows its voices, all English', () => {
    expect(VOICES).toHaveLength(27)
    expect(VOICES.every((v) => /^[ab][fm]_/.test(v.id))).toBe(true)
    expect(isVoice('bf_emma')).toBe(true)
    expect(isVoice('zf_xiaoxiao')).toBe(false)
  })

  it('accepts a sane speed and falls back to normal otherwise', () => {
    expect(speedOf('1.2')).toBe(1.2)
    expect(speedOf(9)).toBe(1)
    expect(speedOf('fast')).toBe(1)
  })
})

describe('astrology, said aloud', () => {
  // Hints are checked on their own below; here, just the words.
  const say = (md: string) => speechText(md).replace(/\[([^\]]+)\]\(\/[^/]+\/\)/g, '$1')

  it('reads a transit table row as one sentence: who, where, which house, doing what to which of yours', () => {
    expect(say("| Jupiter ☐ square Sun | 20°36' Leo ☐ 20°38' Taurus | 9th → 6th | Vision vs. daily action; \"am I overthinking?\" |"))
      .toBe('Jupiter in Leo, your 9th house, squaring your Sun in Taurus, in your 6th house. Vision vs. daily action; "am I overthinking?"')
    expect(say("| Moon △ trine Mercury | 27°30' Leo △ 27°30' Aries | 9th → 5th | A window for creativity |"))
      .toBe('The Moon in Leo, your 9th house, trining your Mercury in Aries, in your 5th house. A window for creativity.')
  })

  it("works the aspect out from the positions, whatever symbol the model put between the names", () => {
    // Written by the model: a Saturn glyph for sextile, a stray symbol before each row, short signs, bare houses.
    expect(say("| ☌ Mercury ♄ MC | 15°35' Sco ♄ 15°34' Vir | 12 → 10 | Insight becomes articulation |"))
      .toBe('Mercury in Scorpio, your 12th house, sextiling your Midheaven in Virgo, in your 10th house. Insight becomes articulation.')
    expect(say("| ☌ Chiron ♄ Pluto | 28°55' Aries ☌ 0°11' Sco | 5 → 12 | Separating |"))
      .toBe('Chiron in Aries, your 5th house, opposing your Pluto in Scorpio, in your 12th house. Separating.')
    expect(say("| ♄ Pluto ♄ Asc | 3°04' Aqu ♄ 3°47' Sag | 1 | Quiet empowerment |"))
      .toBe('Pluto in Aquarius sextiling your Ascendant in Sagittarius, in your 1st house. Quiet empowerment.')
    // No house column at all; and without degrees, the aspect the row names is taken at its word.
    expect(say('| Venus ☌ Moon | 12°10\' Cancer ☌ 12°30\' Cancer | Tender |')).toBe('Venus in Cancer conjunct your Moon in Cancer. Tender.')
    expect(say('| Mars trine Sun | Leo trine Aries | 9 | Drive |')).toBe('Mars in Leo trining your Sun in Aries, in your 9th house. Drive.')
    // Not a transit row: read cell by cell as before.
    expect(say("| Venus | 3°04' Aqu | 1 | a lone position |")).toBe('Venus, 3 degrees Aquarius, 1, a lone position.')
  })

  it('says each aspect once, by name, never as its symbol', () => {
    expect(say('**Jupiter ☐ (square) your Sun — exact at 4:36 PM**')).toBe('Jupiter squaring your Sun — exact at 4:36 PM')
    expect(say('Sun ☐ Jupiter was exact yesterday.')).toBe('Sun square Jupiter was exact yesterday.')
    expect(say('Pluto ✶ sextile Asc, Neptune △ trine Asc, Venus ☌ Mars, Mars ☍ Saturn.'))
      .toBe('Pluto sextile Ascendant, Neptune trine Ascendant, Venus conjunct Mars, Mars opposite Saturn.')
  })

  it('places a body by its sign, and a bare position in degrees', () => {
    expect(say('Transiting Sun 13°00′ Libra ☐ square natal Jupiter 12°46′ Capricorn (2nd house)'))
      .toBe('Transiting Sun in Libra squaring your Jupiter in Capricorn (2nd house)')
    expect(say('The Moon (27°30\' Leo △ 27°30\' Aries, house 5)')).toMatch(/27 degrees Leo trine 27 degrees Aries/)
  })

  it('names glyphs, drops one that only repeats a name, and skips emoji', () => {
    expect(say('Venus ♀ in ♉, Mars ℞ ✅')).toBe('Venus in Taurus, Mars retrograde')
    expect(say('# ☽ Daily Forecast')).toBe('Daily Forecast.')
    expect(say('## 🌙 The Moon\'s Day (in Leo → Virgo)')).toBe("The Moon's Day (in Leo, moving into Virgo).")
  })

  it('reads arrows, dates and comparisons as words', () => {
    expect(say('**10-13 → 2027-02-08**')).toBe('October 13 to February 8, 2027')
    expect(say('- **Now → Feb 2027:** Sabbatical.')).toBe('Now to Feb 2027: Sabbatical.')
    expect(say('- **Runway ≥ 18 mo →** I can be patient.')).toBe('Runway at least 18 months: I can be patient.')
  })
})

describe('pronunciation hints', () => {
  it('tells the voice how to say the names it gets wrong, in its own phoneme spelling', () => {
    expect(speechText('Chiron meets Makemake.')).toBe('[Chiron](/kˈIɹɑn/) meets [Makemake](/mˌɑkAmˈɑkA/).')
  })

  it("leaves possessives, other words and anything already marked alone", () => {
    expect(speechText("Chiron's wound, Uranian, Jupiter.")).toBe("Chiron's wound, Uranian, Jupiter.")
  })
})
