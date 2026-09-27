import { vi } from 'vitest'
import type { ChatEvent } from '../types.ts'

/** Minimal stand-in for a fetch Response; only what the code under test reads. */
export interface FakeResponse {
  ok: boolean
  status: number
  body?: ReadableStream<Uint8Array> | null
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

export type FetchHandler = (url: string, init?: RequestInit) => Promise<unknown>

/** A Response whose body streams the given SSE frames. */
export function sseResponse(frames: string[], { status = 200 } = {}): FakeResponse {
  const encoder = new TextEncoder()
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f))
        controller.close()
      },
    }),
  }
}

/**
 * A stream that delivers `frames`, then fails. Chunks are served from pull()
 * rather than enqueued up front, because controller.error() discards anything
 * still queued -- enqueue-then-error would never deliver them at all.
 */
export function sseThenError(
  frames: string[],
  err: Error = new TypeError('Load failed'),
): FakeResponse {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < frames.length) controller.enqueue(enc.encode(frames[i++]))
        else controller.error(err)
      },
    }),
  }
}

/** One `data:` frame, the shape LM Studio emits. */
export const evt = (obj: ChatEvent): string => `data: ${JSON.stringify(obj)}\n\n`

export function jsonResponse(body: unknown, { status = 200 } = {}): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}

/** LM Studio's error envelope. */
export const lmError = (message: string, status: number): FakeResponse =>
  jsonResponse(
    { error: { message, type: 'invalid_request_error', code: 'invalid_api_key' } },
    { status },
  )

export function mockFetch(handler: FetchHandler) {
  const fn = vi.fn(handler)
  vi.stubGlobal('fetch', fn)
  return fn
}
