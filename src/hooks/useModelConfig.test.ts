import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import useModelConfig from './useModelConfig.ts'
import type { ModelConfig } from '../types.ts'
import { jsonResponse, mockFetch } from '../test/helpers.ts'

const qwen: ModelConfig = {
  found: true,
  model: 'qwen/qwen3.8-27b',
  reasoning: { default: 'xhigh', options: [{ value: 'xhigh', label: 'Extra High' }] },
  thinking: { default: true },
}

describe('useModelConfig', () => {
  it('fetches the manifest for the selected model', async () => {
    const f = mockFetch(() => Promise.resolve(jsonResponse(qwen)))
    const { result } = renderHook(() => useModelConfig('qwen/qwen3.8-27b'))
    await waitFor(() => expect(result.current?.reasoning?.default).toBe('xhigh'))
    expect(f).toHaveBeenCalledWith('/api/model-config?model=qwen%2Fqwen3.8-27b')
  })

  it('does not fetch without a model', () => {
    const f = mockFetch(() => Promise.resolve(jsonResponse(qwen)))
    const { result } = renderHook(() => useModelConfig(''))
    expect(f).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('refetches when the model changes', async () => {
    const f = mockFetch(() => Promise.resolve(jsonResponse(qwen)))
    const { rerender } = renderHook(({ m }) => useModelConfig(m), {
      initialProps: { m: 'a' },
    })
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    rerender({ m: 'b' })
    await waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    expect(f.mock.calls[1][0]).toContain('model=b')
  })

  it('reports null when the endpoint is unavailable', async () => {
    mockFetch(() => Promise.reject(new Error('offline')))
    const { result } = renderHook(() => useModelConfig('qwen'))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('reports null on a non-ok response', async () => {
    mockFetch(() => Promise.resolve(jsonResponse({}, { status: 500 })))
    const { result } = renderHook(() => useModelConfig('qwen'))
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('ignores a response that lands after the model changed', async () => {
    let resolveFirst!: (value: unknown) => void
    const f = vi.fn((url: string) => {
      if (url.includes('model=slow')) return new Promise((r) => { resolveFirst = r })
      return Promise.resolve(jsonResponse({ ...qwen, model: 'fast' }))
    })
    vi.stubGlobal('fetch', f)
    const { result, rerender } = renderHook(({ m }) => useModelConfig(m), {
      initialProps: { m: 'slow' },
    })
    rerender({ m: 'fast' })
    await waitFor(() => expect(result.current?.model).toBe('fast'))
    resolveFirst(jsonResponse({ ...qwen, model: 'slow' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current?.model).toBe('fast')
  })
})
