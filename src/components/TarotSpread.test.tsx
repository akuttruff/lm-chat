import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import TarotSpread from './TarotSpread'
import type { Reading } from '../lib/tarotSpread.ts'

const card = (i: number, name: string, id: string, reversed = false): Reading['cards'][number] => ({ position: { index: i, name: `Position ${i}`, meaning: 'm' }, card: { id, name, arcana: 'minor', suit: 'cups', number: i }, reversed, keywords: [], meaning: '' })

describe('TarotSpread', () => {
  it('lays three cards in a row, each named by its position, reversed ones upside down', () => {
    const reading: Reading = { spread: { id: 'three', name: 'Past, present, future', description: '' }, question: 'Will it rain?', seed: 1, cards: [card(1, 'Ace of Cups', 'cups-01'), card(2, 'The Moon', 'major-18', true), card(3, 'Ten of Wands', 'wands-10')] }
    render(<TarotSpread reading={reading} />)
    expect(screen.getByRole('figure', { name: 'Past, present, future: Will it rain?' })).toBeInTheDocument()
    const moon = screen.getByRole('img', { name: 'Position 2: The Moon, reversed' })
    expect(moon).toHaveAttribute('src', '/tarot/major-18.jpg')
    expect(moon).toHaveStyle({ transform: 'rotate(180deg)' })
    expect(screen.getByRole('img', { name: 'Position 1: Ace of Cups' })).toHaveStyle({ transform: 'rotate(0deg)' })
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('lays ten cards as the cross and staff, the second across the first, with a numbered legend', () => {
    const ids = ['major-00', 'major-01', 'major-02', 'major-03', 'major-04', 'major-05', 'major-06', 'major-07', 'major-08', 'major-09']
    const reading: Reading = { spread: { id: 'celtic-cross', name: 'Celtic Cross', description: '' }, question: null, seed: 2, cards: ids.map((id, i) => card(i + 1, `Card ${i + 1}`, id, i === 1)) }
    const { container } = render(<TarotSpread reading={reading} />)
    expect(container.querySelector('.tarot-cross')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '2. Position 2: Card 2, reversed' })).toHaveStyle({ transform: 'rotate(270deg)' })
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    expect(screen.getAllByRole('listitem')[9]).toHaveTextContent('Position 10Card 10')
  })

  it('takes the pictures from wherever the app serves them', () => {
    const reading: Reading = { spread: { id: 'single', name: 'One card', description: '' }, question: null, seed: 3, cards: [card(1, 'The Moon', 'major-18')] }
    render(<TarotSpread reading={reading} image={(id) => `/api/tarot/${id}.jpg`} />)
    expect(screen.getByRole('img', { name: 'Position 1: The Moon' })).toHaveAttribute('src', '/api/tarot/major-18.jpg')
  })
})
