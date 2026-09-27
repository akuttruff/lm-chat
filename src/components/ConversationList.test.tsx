import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConversationList from './ConversationList.tsx'
import type { Conversation } from '../types.ts'

const now = Date.now()
const convs: Conversation[] = [
  { id: 'a', name: 'Astrology forecast', createdAt: now, updatedAt: now - 60_000, messages: [], responseId: null },
  { id: 'b', name: '', createdAt: now, updatedAt: now - 7_200_000, messages: [], responseId: null },
]

function setup(overrides = {}) {
  const props = {
    open: true,
    conversations: convs,
    activeId: 'a',
    onOpen: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  render(<ConversationList {...props} />)
  return props
}

describe('ConversationList', () => {
  it('lists every conversation', async () => {
    setup()
    expect(await screen.findByText('Astrology forecast')).toBeInTheDocument()
    expect(screen.getByText('New chat')).toBeInTheDocument()
  })

  it('shows relative times', async () => {
    setup()
    await screen.findByText('Astrology forecast')
    expect(screen.getByText('1m')).toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument()
  })

  it('marks chats that are replying or queued in place of their time', async () => {
    setup({
      working: {
        a: { state: 'pending', text: 'writing...', startedAt: now },
        b: { state: 'pending', text: 'waiting for a free slot...', startedAt: now },
      },
    })
    expect(await screen.findByText('replying')).toBeInTheDocument()
    expect(screen.getByText('queued')).toBeInTheDocument()
    expect(screen.queryByText('1m')).not.toBeInTheDocument()
  })

  it('opens a conversation and closes the drawer', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByText('Astrology forecast'))
    expect(props.onOpen).toHaveBeenCalledWith('a')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('exposes rename and delete as labelled controls', async () => {
    setup()
    expect(await screen.findByRole('button', { name: /rename Astrology forecast/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete Astrology forecast/i })).toBeInTheDocument()
  })

  it('deletes a conversation', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('button', { name: /delete Astrology forecast/i }))
    expect(props.onDelete).toHaveBeenCalledWith('a')
  })

  it('renames via the prompt', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'prompt').mockReturnValue('New title')
    const props = setup()
    await user.click(await screen.findByRole('button', { name: /rename Astrology forecast/i }))
    expect(props.onRename).toHaveBeenCalledWith('a', 'New title')
  })

  it('does not rename when the prompt is cancelled', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const props = setup()
    await user.click(await screen.findByRole('button', { name: /rename Astrology forecast/i }))
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByText('Astrology forecast')).not.toBeInTheDocument()
  })
})
