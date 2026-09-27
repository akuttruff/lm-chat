import { describe, it, expect } from 'vitest'
import { Slots, parallelLimit } from './slots.ts'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('Slots', () => {
  it('grants up to the limit and queues the rest', async () => {
    const slots = new Slots(() => 2)
    const a = await slots.acquire('turn')
    await slots.acquire('turn')
    let third = false
    void slots.acquire('turn').then(() => { third = true })
    await tick()
    expect(third).toBe(false)
    expect(slots.waiting).toBe(1)
    a()
    await tick()
    expect(third).toBe(true)
    expect(slots.inUse).toBe(2)
  })

  it('serves waiting turns before background work, whatever the order', async () => {
    const slots = new Slots(() => 1)
    const first = await slots.acquire('turn')
    const order: string[] = []
    void slots.acquire('background').then((r) => { order.push('summary'); r() })
    void slots.acquire('turn').then((r) => { order.push('chat'); r() })
    expect(slots.free('background')).toBe(false)
    first()
    await tick()
    expect(order).toEqual(['chat', 'summary'])
  })

  it('gives up a queued place when aborted', async () => {
    const slots = new Slots(() => 1)
    const held = await slots.acquire('turn')
    const controller = new AbortController()
    const waiting = slots.acquire('turn', controller.signal)
    controller.abort(new DOMException('stopped', 'AbortError'))
    await expect(waiting).rejects.toThrow('stopped')
    expect(slots.waiting).toBe(0)
    held()
    expect(slots.inUse).toBe(0)
  })

  it('ignores a second release', async () => {
    const slots = new Slots(() => 1)
    const release = await slots.acquire('turn')
    release()
    release()
    expect(slots.inUse).toBe(0)
  })

  it('has no cap at 0, and follows a changed limit', async () => {
    let limit = 0
    const slots = new Slots(() => limit)
    await Promise.all([1, 2, 3, 4, 5].map(() => slots.acquire('turn')))
    expect(slots.inUse).toBe(5)
    limit = 1
    expect(slots.free()).toBe(false)
  })

  it('parses the setting, defaulting to 4', () => {
    expect(parallelLimit('2')).toBe(2)
    expect(parallelLimit('0')).toBe(0)
    expect(parallelLimit('')).toBe(4)
    expect(parallelLimit(undefined)).toBe(4)
    expect(parallelLimit('-1')).toBe(4)
  })
})
