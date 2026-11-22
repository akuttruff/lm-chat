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
