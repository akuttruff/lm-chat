import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEventSource } from '../test/sse.ts'
import type { FakeEventSource } from '../test/sse.ts'
import { LIVE, openLive } from './live.ts'
import type { Live, LinkState } from './live.ts'

let ES: typeof FakeEventSource
let live: Live | null = null
let states: LinkState[]
let opens: number
let messages: string[]

const start = (): Live => {
  live = openLive({
    url: '/api/events',
    onState: (s) => states.push(s),
    onOpen: () => { opens++ },
    onMessage: (d) => messages.push(d),
    events: { snapshot: (d) => messages.push(`snapshot:${d}`) },
  })
  return live
}

beforeEach(() => {
  vi.useFakeTimers()
  ES = stubEventSource()
  states = []
  opens = 0
  messages = []
})
afterEach(() => {
  live?.close()
  live = null
  vi.useRealTimers()
})

describe('openLive', () => {
  it('reports live on open and passes messages and named events on', () => {
    start()
    ES.latest().open()
    ES.latest().emit({ a: 1 })
    ES.latest().emitNamed('snapshot', 'x')
    expect(states).toEqual(['live'])
    expect(opens).toBe(1)
    expect(messages).toEqual(['{"a":1}', 'snapshot:x'])
  })

  it('does not report a drop that heals within the grace period', () => {
    start()
    ES.latest().open()
    ES.latest().fail()
    vi.advanceTimersByTime(LIVE.downAfterMs / 2)
    ES.latest().open()
    vi.advanceTimersByTime(LIVE.downAfterMs * 2)
    expect(states).toEqual(['live'])
  })

  it('reports a drop that lasts', () => {
    start()
    ES.latest().open()
    ES.latest().fail()
    vi.advanceTimersByTime(LIVE.downAfterMs + 10)
    expect(states).toEqual(['live', 'down'])
  })

  it('opens a new stream when the browser gives up on one', () => {
    start()
    ES.latest().open()
    ES.latest().fail(true)
    expect(ES.instances).toHaveLength(1)
    vi.advanceTimersByTime(LIVE.retryMs[0]!)
    expect(ES.instances).toHaveLength(2)
    expect(ES.instances[0]!.closed).toBe(true)
    ES.latest().open()
    expect(states.at(-1)).toBe('live')
    expect(opens).toBe(2)
  })

  it('backs off between failed tries, then resets once open', () => {
    start()
    ES.latest().fail(true)
    vi.advanceTimersByTime(LIVE.retryMs[0]!)
    ES.latest().fail(true)
    vi.advanceTimersByTime(LIVE.retryMs[0]!)
    expect(ES.instances).toHaveLength(2) // the second wait is longer
    vi.advanceTimersByTime(LIVE.retryMs[1]! - LIVE.retryMs[0]!)
    expect(ES.instances).toHaveLength(3)
    ES.latest().open()
    ES.latest().fail(true)
    vi.advanceTimersByTime(LIVE.retryMs[0]!)
    expect(ES.instances).toHaveLength(4)
  })

  it('gives up on a stream that never opens', () => {
    start()
    vi.advanceTimersByTime(LIVE.openTimeoutMs)
    vi.advanceTimersByTime(LIVE.retryMs[0]!)
    expect(ES.instances).toHaveLength(2)
  })

  it('gives up on a retry that hangs', () => {
    start()
    ES.latest().open()
    ES.latest().fail() // the browser is retrying...
    vi.advanceTimersByTime(LIVE.openTimeoutMs) // ...and it never answers
    vi.advanceTimersByTime(LIVE.retryMs[0]!)
    expect(ES.instances).toHaveLength(2)
  })

  it('replaces a stream that has gone silent, and pings keep it alive', () => {
    start()
    ES.latest().open()
    for (let t = 0; t < LIVE.staleMs * 2; t += LIVE.heartbeatMs) {
      vi.advanceTimersByTime(LIVE.heartbeatMs)
      ES.latest().emitNamed('ping')
    }
    expect(ES.instances).toHaveLength(1)
    vi.advanceTimersByTime(LIVE.staleMs + LIVE.checkMs * 2)
    expect(ES.instances).toHaveLength(2)
  })

  it('reopens at once when the page comes back after a sleep', () => {
    start()
    ES.latest().open()
    vi.advanceTimersByTime(LIVE.heartbeatMs + 6_000) // asleep: no pings arrived, and the watchdog hasn't looked yet
    vi.setSystemTime(Date.now())
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(0)
    expect(ES.instances.length).toBeGreaterThanOrEqual(2)
  })

  it('stops for good when closed', () => {
    const l = start()
    ES.latest().open()
    l.close()
    vi.advanceTimersByTime(LIVE.staleMs * 3)
    expect(ES.instances).toHaveLength(1)
    expect(ES.latest().closed).toBe(true)
  })
})
