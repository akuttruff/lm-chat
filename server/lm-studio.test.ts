import { describe, it, expect, vi, afterEach } from 'vitest'
import { lmStudioBase, lmStudioFetch } from './lm-studio.ts'

afterEach(() => vi.unstubAllGlobals())

describe('lmStudioFetch', () => {
  it('joins the path onto the address and sends the trimmed token alongside the caller\'s headers', async () => {
    const f = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', f)
    await lmStudioFetch({ lmStudioUrl: 'http://127.0.0.1:1234//', apiToken: ' secret \n' }, '/api/v1/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    expect(f).toHaveBeenCalledWith('http://127.0.0.1:1234/api/v1/chat', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
    })
  })

  it('sends no Authorization header without a token', async () => {
    const f = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', f)
    await lmStudioFetch({ lmStudioUrl: 'http://lm', apiToken: '' }, '/api/v1/models')
    expect(f).toHaveBeenCalledWith('http://lm/api/v1/models', { headers: {} })
  })

  it('strips trailing slashes from the address', () => {
    expect(lmStudioBase({ lmStudioUrl: 'http://lm/', apiToken: '' })).toBe('http://lm')
  })
})
