import { describe, expect, it } from 'vitest'
import { imageFor, layoutFor, looksLikeReading, parseReading, turnOf } from './tarotSpread.ts'

const card = (i: number, id: string, name: string, reversed = false) => ({ position: { index: i, name: `P${i}`, meaning: 'm' }, card: { id, name, arcana: 'major', suit: null, number: i }, reversed, keywords: ['k'], meaning: 'text' })
const reading = { spread: { id: 'three', name: 'Past, present, future', description: 'd' }, question: 'Q?', drawnAt: 'x', seed: 1, cards: [card(1, 'major-00', 'The Fool'), card(2, 'cups-03', 'Three of Cups', true), card(3, 'major-16', 'The Tower')], summary: {} }

describe('tarotSpread', () => {
  it('tells a reading from other results and parses it', () => {
    const text = JSON.stringify(reading)
    expect(looksLikeReading(text)).toBe(true)
    expect(looksLikeReading('{"houses":[],"objects":[]}')).toBe(false)
    expect(parseReading(text)).toMatchObject({ spread: { id: 'three' }, question: 'Q?', seed: 1 })
    expect(parseReading(text)!.cards).toHaveLength(3)
    expect(parseReading('nope')).toBeNull()
    expect(parseReading(JSON.stringify({ spread: { id: 'x' }, cards: [] }))).toBeNull()
    expect(parseReading(JSON.stringify({ spread: { id: 'x' }, cards: [{ card: {} }] }))).toBeNull()
  })

  it('lays ten cards as the Celtic Cross and anything else as a row', () => {
    const cross = layoutFor('celtic-cross', 10)
    expect(cross.kind).toBe('cross')
    expect(cross.slots).toHaveLength(10)
    expect(cross.slots[1]).toEqual({ x: 1.15, y: 1.0, turn: 90 })
    const row = layoutFor('three', 3)
    expect(row).toMatchObject({ kind: 'row', cols: 3, rows: 1 })
    expect(layoutFor('row-7', 7)).toMatchObject({ cols: 5, rows: 2 })
    expect(layoutFor('celtic-cross', 3).kind).toBe('row')
  })

  it('turns a reversed card upside down, and the crossing card across', () => {
    expect(turnOf({ x: 0, y: 0, turn: 0 }, false)).toBe(0)
    expect(turnOf({ x: 0, y: 0, turn: 0 }, true)).toBe(180)
    expect(turnOf({ x: 0, y: 0, turn: 90 }, false)).toBe(90)
    expect(turnOf({ x: 0, y: 0, turn: 90 }, true)).toBe(270)
    expect(imageFor('swords-03')).toBe('/tarot/swords-03.jpg')
    expect(imageFor('swords-03', '/api/tarot/')).toBe('/api/tarot/swords-03.jpg')
  })
})
