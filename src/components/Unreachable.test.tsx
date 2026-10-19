import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import Unreachable from './Unreachable.tsx'
import { reachFetch } from '../lib/reach.ts'

const answered = () => Promise.resolve(new Response('{}', { status: 200 }))
const lost = () => Promise.reject(new TypeError('Load failed'))

/** Put the server in reach (or out of it) the way the app finds out: by asking it something. */
const serverIs = async (there: boolean): Promise<void> => {
  vi.stubGlobal('fetch', vi.fn(there ? answered : lost))
  await act(async () => { await reachFetch('/api/chats').catch(() => {}) })
}

describe('Unreachable', () => {
  it('shows nothing while the server answers', async () => {
    await serverIs(true)
    render(<Unreachable app="LM Chat" />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the server is out of reach once a request has got no reply, and names Tailscale', async () => {
    render(<Unreachable app="LM Chat" />)
    await serverIs(false)
    const strip = await screen.findByRole('status')
    expect(strip).toHaveTextContent("Can't reach LM Chat")
    expect(strip).toHaveTextContent('Tailscale')
  })

  it('keeps looking, and goes once the server answers, telling the app to refetch', async () => {
    const onBack = vi.fn()
    render(<Unreachable app="LM Chat" onBack={onBack} />)
    await serverIs(false)
    await screen.findByRole('status')
    // The next look finds the server back.
    vi.stubGlobal('fetch', vi.fn(answered))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/config', expect.anything())
  })

  it('looks at once when asked', async () => {
    render(<Unreachable app="LM Chat" />)
    await serverIs(false)
    const strip = await screen.findByRole('status')
    vi.stubGlobal('fetch', vi.fn(answered))
    await userEvent.click(screen.getByRole('button', { name: 'Try now' }))
    await waitFor(() => expect(strip).not.toBeInTheDocument())
  })
})
