import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'sonner'
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

  it('counts a chat held only in outline, without its messages', async () => {
    const outlined = convs.map((c) => (c.id === 'a' ? { ...c, messages: [], messageCount: 12, messagesOmitted: true } : c))
    setup({ conversations: outlined })
    expect(await screen.findByText('12 msgs · 1m')).toBeInTheDocument()
  })

  it('shows the message count before the time, for a thread that has messages', async () => {
    const withMessages = convs.map((c) => (
      c.id === 'a' ? { ...c, messages: Array.from({ length: 5 }, (_, i) => ({ id: i, role: 'user' as const, text: 'hi' })) } : c
    ))
    setup({ conversations: withMessages })
    expect(await screen.findByText('5 msgs · 1m')).toBeInTheDocument()
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

  it('offers delete and rename on hover for a mouse, as the same actions', async () => {
    const user = userEvent.setup()
    const props = setup()
    await screen.findByText('Astrology forecast')
    const [first] = document.querySelectorAll('.conv-hover-actions')
    await user.click(first!.querySelector('button.danger')!)
    expect(props.onDelete).toHaveBeenCalledWith('a')
  })

  it('deletes the focused chat with the Delete key', async () => {
    const user = userEvent.setup()
    const props = setup()
    const row = (await screen.findByText('Astrology forecast')).closest('button')!
    row.focus()
    await user.keyboard('{Delete}')
    expect(props.onDelete).toHaveBeenCalledWith('a')
  })

  it('undoes a deletion by restoring the chat, not renaming it', async () => {
    const user = userEvent.setup()
    const onRestore = vi.fn()
    const props = setup({ onRestore })
    render(<Toaster />)
    await user.click(await screen.findByRole('button', { name: /delete Astrology forecast/i }))
    // The newest toast (sonner's index 0): earlier tests' toasts linger in its shared state.
    // fireEvent, since jsdom has no stylesheet to lift the open drawer's
    // pointer-events: none -- App.css does that for real taps.
    const undos = await screen.findAllByRole('button', { name: 'Undo' })
    const newest = undos.find((b) => b.closest('[data-sonner-toast]')?.getAttribute('data-index') === '0')!
    fireEvent.click(newest)
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', name: 'Astrology forecast' }))
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByText('Astrology forecast')).not.toBeInTheDocument()
  })
})
