import { describe, it, expect, beforeEach } from 'vitest'
import { computeInitialScrollState, findAnchor, loadScrollAnchor, saveScrollAnchor } from './scrollMemory.ts'
import type { Message } from '../types.ts'

beforeEach(() => { localStorage.clear() })

const msg = (id: string): Message => ({ id, role: 'assistant', text: id })

describe('saveScrollAnchor / loadScrollAnchor', () => {
  it('round-trips', () => {
    saveScrollAnchor('c1', { anchorId: 'm5', offset: 42 })
    expect(loadScrollAnchor('c1')).toEqual({ anchorId: 'm5', offset: 42 })
  })

  it('keeps different conversations apart', () => {
    saveScrollAnchor('c1', { anchorId: 'a', offset: 1 })
    saveScrollAnchor('c2', { anchorId: 'b', offset: 2 })
    expect(loadScrollAnchor('c1')).toEqual({ anchorId: 'a', offset: 1 })
    expect(loadScrollAnchor('c2')).toEqual({ anchorId: 'b', offset: 2 })
  })

  it('null clears it', () => {
    saveScrollAnchor('c1', { anchorId: 'a', offset: 1 })
    saveScrollAnchor('c1', null)
    expect(loadScrollAnchor('c1')).toBeNull()
  })

  it('is null for a conversation that was never saved', () => {
    expect(loadScrollAnchor('never-seen')).toBeNull()
  })

  it('ignores garbage left in storage rather than throwing', () => {
    localStorage.setItem('lm-chat.scroll.c1', 'not json')
    expect(loadScrollAnchor('c1')).toBeNull()
    localStorage.setItem('lm-chat.scroll.c1', JSON.stringify({ anchorId: 'a' })) // no offset
    expect(loadScrollAnchor('c1')).toBeNull()
  })

  it('tolerates storage being unavailable', () => {
    const real = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    Object.defineProperty(window, 'localStorage', { value: { getItem() { throw new Error('blocked') } } })
    try {
      expect(loadScrollAnchor('c1')).toBeNull()
    } finally {
      Object.defineProperty(window, 'localStorage', real)
    }
  })
})

describe('findAnchor', () => {
  /** A container with rows at the given offsets/heights, all `h` tall unless given. */
  function containerWith(rows: { id: string; top: number; height?: number }[], scrollTop: number): HTMLElement {
    const el = document.createElement('div')
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true })
    for (const r of rows) {
      const row = document.createElement('div')
      row.dataset.msgId = r.id
      Object.defineProperty(row, 'offsetTop', { value: r.top, configurable: true })
      Object.defineProperty(row, 'offsetHeight', { value: r.height ?? 100, configurable: true })
      el.appendChild(row)
    }
    return el
  }

  it('picks the row the top of the view has scrolled into', () => {
    const el = containerWith([{ id: 'a', top: 0 }, { id: 'b', top: 100 }, { id: 'c', top: 200 }], 150)
    expect(findAnchor(el)).toEqual({ anchorId: 'b', offset: 50 })
  })

  it('is the first row, offset 0, at the very top', () => {
    const el = containerWith([{ id: 'a', top: 0 }, { id: 'b', top: 100 }], 0)
    expect(findAnchor(el)).toEqual({ anchorId: 'a', offset: 0 })
  })

  it('is the last row once scrolled past every row start', () => {
    const el = containerWith([{ id: 'a', top: 0 }, { id: 'b', top: 100 }], 500)
    expect(findAnchor(el)).toEqual({ anchorId: 'b', offset: 400 })
  })

  it('is null with nothing rendered', () => {
    expect(findAnchor(containerWith([], 0))).toBeNull()
  })
})

describe('computeInitialScrollState', () => {
  const messages = Array.from({ length: 10 }, (_, i) => msg(`m${i}`))

  it('defaults to the bottom with nothing saved', () => {
    expect(computeInitialScrollState('c1', messages, 4)).toEqual({ shown: 4, following: true, restore: null })
  })

  it('widens the window to include a saved anchor further back than it', () => {
    saveScrollAnchor('c1', { anchorId: 'm2', offset: 10 }) // 8 messages from the end
    expect(computeInitialScrollState('c1', messages, 4)).toEqual({
      shown: 8, following: false, restore: { anchorId: 'm2', offset: 10 },
    })
  })

  it('does not shrink the window below the usual default', () => {
    saveScrollAnchor('c1', { anchorId: 'm9', offset: 5 }) // the very last message: 1 from the end
    expect(computeInitialScrollState('c1', messages, 4).shown).toBe(4)
  })

  it('falls back to the bottom when the saved message is gone', () => {
    saveScrollAnchor('c1', { anchorId: 'deleted', offset: 10 })
    expect(computeInitialScrollState('c1', messages, 4)).toEqual({ shown: 4, following: true, restore: null })
  })

  it('is unaffected by another conversation\'s saved position', () => {
    saveScrollAnchor('c2', { anchorId: 'm2', offset: 10 })
    expect(computeInitialScrollState('c1', messages, 4).following).toBe(true)
  })

  it('matches a numeric id saved and reloaded through JSON', () => {
    const numeric = [{ id: 3, role: 'assistant', text: 'x' } as Message, msg('m1')]
    saveScrollAnchor('c1', { anchorId: 3, offset: 0 })
    expect(computeInitialScrollState('c1', numeric, 1).following).toBe(false)
  })
})
