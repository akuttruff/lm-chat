import os from 'node:os'
import path from 'node:path'
import '@testing-library/jest-dom/vitest'
import { REACH } from '../lib/reach.ts'

// The waits around a server that gives no reply, cut to a few ticks: a test
// that sits through eight seconds of silence learns nothing from the wait.
REACH.readTimeoutMs = 200
REACH.retryWaitsMs = [10, 20, 30]
REACH.unreachableAfterMs = 40
REACH.probeMs = 40

// jsdom implements neither of these, and Motion calls them while measuring
// keyframes. Without the stubs every animated test logs a "Not implemented"
// stack that buries real failures.
window.scrollTo = (() => {}) as typeof window.scrollTo
// Vaul drags with pointer capture, which jsdom does not implement.
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.hasPointerCapture = () => false
}
// jsdom returns "" for transform/webkitTransform and undefined for
// mozTransform, so Vaul's `a || b || c` chain lands on undefined and it calls
// .match() on it while settling a drag. Report a real value instead.
const TRANSFORM_PROPS = new Set<string | symbol>(['transform', 'webkitTransform', 'mozTransform'])
const realGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (el, pseudo) => {
  const style = realGetComputedStyle(el, pseudo)
  return new Proxy(style, {
    get(target, prop) {
      const v = (target as unknown as Record<string | symbol, unknown>)[prop]
      if (TRANSFORM_PROPS.has(prop) && !v) return 'none'
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

beforeEach(() => {
  localStorage.clear()
  // Every suite opts in to the fetch behaviour it wants; an un-stubbed call
  // should fail loudly rather than hit the network.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unstubbed fetch'))))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

// jsdom does no layout, so it has no scrollIntoView; components call it on focus.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}

// No test may read or write the real memory pool (~/.lm-memory). One that
// wants memories passes its own file; everything else sees none.
process.env.MEMORY_DB = path.join(os.tmpdir(), `lm-chat-test-no-memory-${process.pid}.sqlite`)
