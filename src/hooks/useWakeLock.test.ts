import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import useWakeLock from './useWakeLock.ts'

function fakeWakeLock() {
  const release = vi.fn(() => Promise.resolve())
  const request = vi.fn(() => Promise.resolve({ release } as unknown as WakeLockSentinel))
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request }, configurable: true, writable: true,
  })
  return { request, release }
}

function hide(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => { hide('visible') })

describe('useWakeLock', () => {
  it('takes a screen lock while active', async () => {
    const { request } = fakeWakeLock()
    await act(async () => { renderHook(() => useWakeLock(true)) })
    expect(request).toHaveBeenCalledWith('screen')
  })

  it('takes no lock when inactive', async () => {
    const { request } = fakeWakeLock()
    await act(async () => { renderHook(() => useWakeLock(false)) })
    expect(request).not.toHaveBeenCalled()
  })

  it('releases the lock when the reply finishes', async () => {
    const { release } = fakeWakeLock()
    const { rerender } = renderHook(({ on }) => useWakeLock(on), {
      initialProps: { on: true },
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { rerender({ on: false }) })
    expect(release).toHaveBeenCalled()
  })

  it('releases on unmount', async () => {
    const { release } = fakeWakeLock()
    const { unmount } = renderHook(() => useWakeLock(true))
    await act(async () => { await Promise.resolve() })
    await act(async () => { unmount() })
    expect(release).toHaveBeenCalled()
  })

  it('re-takes the lock when returning to the tab', async () => {
    // iOS drops the lock on hide; without this the screen sleeps mid-reply.
    const { request } = fakeWakeLock()
    renderHook(() => useWakeLock(true))
    await act(async () => { await Promise.resolve() })
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => { hide('hidden') })
    await act(async () => { hide('visible') })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('survives a browser without the API', async () => {
    Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true })
    expect(() => renderHook(() => useWakeLock(true))).not.toThrow()
  })

  it('survives the request being refused', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: vi.fn(() => Promise.reject(new Error('not allowed'))) },
      configurable: true,
    })
    await act(async () => { renderHook(() => useWakeLock(true)) })
    expect(true).toBe(true) // no unhandled rejection
  })
})
