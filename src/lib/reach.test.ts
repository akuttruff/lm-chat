import { afterEach, describe, expect, it, vi } from 'vitest'
import { REACH, reach, reachFetch } from './reach.ts'

const answered = () => Promise.resolve(new Response('{}', { status: 200 }))
const lost = () => Promise.reject(new TypeError('Load failed'))
/** A request that only ends when its signal aborts, as one into a dead tunnel does. */
const hanging = (_: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))

afterEach(() => { vi.useRealTimers() })

describe('reachFetch', () => {
  it('tries a read again after no reply, and reports the server back once it answers', async () => {
    const seen: boolean[] = []
    const off = reach.subscribe((d) => seen.push(d))
    const f = vi.fn().mockImplementationOnce(lost).mockImplementationOnce(lost).mockImplementation(answered)
    vi.stubGlobal('fetch', f)
    expect((await reachFetch('/api/chats')).ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([true, false])
    off()
  })

  it('gives up after the last wait and leaves the server reported out of reach', async () => {
    vi.stubGlobal('fetch', vi.fn(lost))
    await expect(reachFetch('/api/folders')).rejects.toThrow(TypeError)
    expect(fetch).toHaveBeenCalledTimes(REACH.retryWaitsMs.length + 1)
    expect(reach.down).toBe(true)
  })

  it('sends a write once, however it fails', async () => {
    vi.stubGlobal('fetch', vi.fn(lost))
    await expect(reachFetch('/api/chats', { method: 'POST', body: '{}' })).rejects.toThrow(TypeError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('counts an answer with an error as the server being there', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"error":"no"}', { status: 500 }))))
    expect((await reachFetch('/api/folders')).status).toBe(500)
    expect(reach.down).toBe(false)
  })

  it('neither retries nor blames the server for a request the caller aborted', async () => {
    vi.stubGlobal('fetch', vi.fn(hanging))
    const ctl = new AbortController()
    const p = reachFetch('/api/chats', { signal: ctl.signal })
    ctl.abort(new DOMException('left the chat', 'AbortError'))
    await expect(p).rejects.toThrow('left the chat')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(reach.down).toBe(false)
  })

  it('gives up on a read that never answers, then tries again', async () => {
    vi.useFakeTimers()
    const f = vi.fn().mockImplementationOnce(hanging).mockImplementation(answered)
    vi.stubGlobal('fetch', f)
    const p = reachFetch('/api/config')
    await vi.advanceTimersByTimeAsync(REACH.readTimeoutMs + REACH.retryWaitsMs[0]! + 1)
    expect((await p).ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)
    expect(reach.down).toBe(false)
  })

  it('lets a write wait as long as it takes', async () => {
    vi.useFakeTimers()
    let settle: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { settle = r })))
    const p = reachFetch('/api/chats', { method: 'POST', body: '{}' })
    await vi.advanceTimersByTimeAsync(REACH.readTimeoutMs * 3)
    settle(new Response('{}', { status: 201 }))
    expect((await p).status).toBe(201)
  })
})
