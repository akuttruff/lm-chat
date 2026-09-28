import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MemoriesSheet from './MemoriesSheet.tsx'
import type { Memory } from '../types.ts'

const green: Memory = { id: 'a1', text: 'Favorite color is green', createdAt: 1, updatedAt: 1 }
const born: Memory = { id: 'b2', text: 'Born May 10, 1984', createdAt: 2, updatedAt: 2 }

function stub(list: Memory[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) as { text: string } : undefined
    calls.push({ url, method, body })
    if (method === 'PATCH') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...green, text: body!.text, updatedAt: 9 }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(method === 'GET' ? list : { ok: true }) })
  }))
  return calls
}

describe('MemoriesSheet', () => {
  it('lists what has been remembered', async () => {
    stub([born, green])
    render(<MemoriesSheet open onClose={vi.fn()} />)
    expect(await screen.findByText('Born May 10, 1984')).toBeInTheDocument()
    expect(screen.getByText('Favorite color is green')).toBeInTheDocument()
  })

  it('says so when nothing has been remembered', async () => {
    stub([])
    render(<MemoriesSheet open onClose={vi.fn()} />)
    expect(await screen.findByText(/Nothing remembered yet/)).toBeInTheDocument()
  })

  it('edits a memory', async () => {
    const user = userEvent.setup()
    const calls = stub([green])
    render(<MemoriesSheet open onClose={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Edit: Favorite color is green' }))
    const box = screen.getByLabelText('Memory text')
    await user.clear(box)
    await user.type(box, 'Favorite color is blue')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Favorite color is blue')).toBeInTheDocument()
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({ url: '/api/memories/a1', body: { text: 'Favorite color is blue' } })
  })

  it('forgets a memory after confirming, and keeps it when you cancel', async () => {
    const user = userEvent.setup()
    const calls = stub([green])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<MemoriesSheet open onClose={vi.fn()} />)
    const forget = await screen.findByRole('button', { name: 'Forget: Favorite color is green' })
    await user.click(forget)
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    await user.click(forget)
    await waitFor(() => expect(screen.queryByText('Favorite color is green')).not.toBeInTheDocument())
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/memories/a1')
    confirm.mockRestore()
  })

  it('shows why when memories could not be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })))
    render(<MemoriesSheet open onClose={vi.fn()} />)
    expect(await screen.findByText(/Couldn.t load memories/)).toHaveTextContent('HTTP 500')
  })
})
