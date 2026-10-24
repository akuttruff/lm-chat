import { describe, expect, it } from 'vitest'
import { nextSort, sortRows } from './sortRows.ts'

const rows = [
  { id: 'a', from: 'Mars', to: 'Venus', orb: 0.42, exact: '2026-10-17 05:04', weight: 0.7 },
  { id: 'b', from: 'Moon', to: 'Sun', orb: 0.15, exact: '2026-10-17 23:47', weight: 0.4 },
  { id: 'c', from: 'Neptune', to: 'Chiron', orb: 0.33, exact: null, nearestExact: '2026-11-01 16:51', weight: 2.5 },
  { id: 'd', from: 'Pluto', to: 'Ascendant', orb: 0.72, exact: null, weight: null },
  { id: 'e', from: 'Mars', to: 'Uranus', orb: 1.01, exact: '2026-10-19 20:15', weight: 0.7 },
]
const ids = (r: { id: string }[]) => r.map((x) => x.id).join('')

describe('sortRows', () => {
  it('leaves the table in its own order with no sort', () => {
    expect(sortRows(rows, null)).toBe(rows)
  })
  it('sorts by the orb, closest first or last', () => {
    expect(ids(sortRows(rows, { key: 'orb', dir: 'asc' }))).toBe('bcade')
    expect(ids(sortRows(rows, { key: 'orb', dir: 'desc' }))).toBe('edacb')
  })
  it('sorts by the moment, using the nearest one when a row never perfects, and keeps rows with none last', () => {
    expect(ids(sortRows(rows, { key: 'when', dir: 'asc' }))).toBe('abecd')
    expect(ids(sortRows(rows, { key: 'when', dir: 'desc' }))).toBe('cebad')
  })
  it('sorts by weight, lightest or heaviest first, and keeps rows with none last', () => {
    expect(ids(sortRows(rows, { key: 'weight', dir: 'asc' }))).toBe('baecd')
    expect(ids(sortRows(rows, { key: 'weight', dir: 'desc' }))).toBe('caebd')
  })

  it('groups by either planet, keeping the table order within a group', () => {
    expect(ids(sortRows(rows, { key: 'from', dir: 'asc' }))).toBe('aebcd')
    expect(ids(sortRows(rows, { key: 'from', dir: 'desc' }))).toBe('dcbae')
    expect(ids(sortRows(rows, { key: 'to', dir: 'asc' }))).toBe('dcbea')
  })
  it('cycles a header through up, down and off, and a new header starts up', () => {
    expect(nextSort(null, 'orb')).toEqual({ key: 'orb', dir: 'asc' })
    expect(nextSort({ key: 'orb', dir: 'asc' }, 'orb')).toEqual({ key: 'orb', dir: 'desc' })
    expect(nextSort({ key: 'orb', dir: 'desc' }, 'orb')).toBeNull()
    expect(nextSort({ key: 'orb', dir: 'desc' }, 'when')).toEqual({ key: 'when', dir: 'asc' })
  })
})
