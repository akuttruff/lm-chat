// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * Sorting a transit table by a column: the moment it is exact, the
 * transiting body, how close the orb is, the natal point, or its weight. A click on a
 * header sorts ascending, another descending, a third puts the table back
 * in its own order. Ties keep that order, so sorting by planet groups the
 * rows without shuffling them.
 */

export type SortKey = 'when' | 'from' | 'orb' | 'to' | 'weight'
export type SortDir = 'asc' | 'desc'
export interface Sort { key: SortKey; dir: SortDir }

/** What a row must carry to be sorted. */
export interface Sortable {
  from: string
  to: string
  orb: number
  exact: string | null
  nearestExact?: string | null
  /** Null when the scale has no number for the row; it sorts last either way. */
  weight?: number | null
}

/** The sort a click on `key` leads to from `current`: up, then down, then none. */
export function nextSort(current: Sort | null, key: SortKey): Sort | null {
  if (!current || current.key !== key) return { key, dir: 'asc' }
  return current.dir === 'asc' ? { key, dir: 'desc' } : null
}

/** A row's moment for the When column: when it is exact, else the nearest moment it is; none sorts last either way. */
const whenOf = (r: Sortable): string | null => r.exact ?? r.nearestExact ?? null

function compare(a: Sortable, b: Sortable, key: SortKey): number {
  switch (key) {
    case 'when': {
      const x = whenOf(a); const y = whenOf(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
      return x < y ? -1 : x > y ? 1 : 0
    }
    case 'from': return a.from.localeCompare(b.from)
    case 'to': return a.to.localeCompare(b.to)
    case 'orb': return a.orb - b.orb
    case 'weight': {
      const x = a.weight ?? null; const y = b.weight ?? null
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
      return x - y
    }
  }
}

/** Whether the row has nothing to sort by under the key: no moment, or no weight. */
const blank = (r: Sortable, key: SortKey): boolean => key === 'when' ? whenOf(r) === null : key === 'weight' ? (r.weight ?? null) === null : false

/** The rows in the sort's order (a new array), or as given when there is no sort. */
export function sortRows<T extends Sortable>(rows: T[], sort: Sort | null): T[] {
  if (!sort) return rows
  const sign = sort.dir === 'asc' ? 1 : -1
  return rows.map((row, i) => ({ row, i })).sort((a, b) => {
    const c = compare(a.row, b.row, sort.key)
    // A row with no moment, or no weight, stays last whichever way the rest run.
    if (c !== 0 && (blank(a.row, sort.key) || blank(b.row, sort.key))) return c
    return c !== 0 ? c * sign : a.i - b.i
  }).map((x) => x.row)
}
