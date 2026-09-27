import { describe, it, expect } from 'vitest'
import type { ServerResponse } from 'node:http'
import { Bus, MAX_BACKLOG_BYTES } from './bus.ts'

/** Just enough of a ServerResponse to see what the bus does with it. */
function fakeClient(backlog = 0) {
  const client = {
    frames: [] as string[],
    writableLength: backlog,
    destroyed: false,
    writableEnded: false,
    write(frame: string) { this.frames.push(frame); return true },
    destroy() { this.destroyed = true },
  }
  return client as typeof client & ServerResponse
}

const status = { type: 'status', payload: { conversationId: 'c', state: '', text: '', startedAt: null } } as const

describe('Bus', () => {
  it('sends every event to every client', () => {
    const bus = new Bus()
    const a = fakeClient()
    const b = fakeClient()
    bus.add(a)
    bus.add(b)
    bus.send(status)
    expect(a.frames).toHaveLength(1)
    expect(b.frames[0]).toMatch(/^data: \{"type":"status"/)
  })

  it('cuts loose a client that has stopped reading, instead of buffering for it forever', () => {
    // The 4 GB crash: a locked phone kept its socket open and every frame
    // queued in memory.
    const bus = new Bus()
    const asleep = fakeClient(MAX_BACKLOG_BYTES + 1)
    const awake = fakeClient()
    bus.add(asleep)
    bus.add(awake)
    bus.send(status)
    expect(asleep.destroyed).toBe(true)
    expect(asleep.frames).toHaveLength(0)
    expect(bus.size).toBe(1)
    bus.send(status)
    expect(awake.frames).toHaveLength(2)
  })

  it('keeps a client that is merely a little behind', () => {
    const bus = new Bus()
    const slow = fakeClient(64 * 1024)
    bus.add(slow)
    bus.send(status)
    expect(slow.destroyed).toBe(false)
    expect(slow.frames).toHaveLength(1)
  })

  it('forgets a client whose connection already ended', () => {
    const bus = new Bus()
    const gone = fakeClient()
    gone.writableEnded = true
    bus.add(gone)
    bus.send(status)
    expect(bus.size).toBe(0)
  })
})
