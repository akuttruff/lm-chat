import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'sonner'
import ConversationList, { fullDateTime } from './ConversationList.tsx'
import type { Conversation, Folder } from '../types.ts'

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
    folders: [] as Folder[],
    onOpen: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onStar: vi.fn(),
    onOpenFolderPicker: vi.fn(),
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

  it('shows the full date and time, not a relative one that keeps sliding', async () => {
    setup()
    await screen.findByText('Astrology forecast')
    expect(screen.getByText(fullDateTime(convs[0]!.updatedAt))).toBeInTheDocument()
    expect(screen.getByText(fullDateTime(convs[1]!.updatedAt))).toBeInTheDocument()
  })

  it('counts a chat held only in outline, without its messages', async () => {
    const outlined = convs.map((c) => (c.id === 'a' ? { ...c, messages: [], messageCount: 12, messagesOmitted: true } : c))
    setup({ conversations: outlined })
    expect(await screen.findByText(`12 msgs · ${fullDateTime(convs[0]!.updatedAt)}`)).toBeInTheDocument()
  })

  it('shows the message count before the date, for a thread that has messages', async () => {
    const withMessages = convs.map((c) => (
      c.id === 'a' ? { ...c, messages: Array.from({ length: 5 }, (_, i) => ({ id: i, role: 'user' as const, text: 'hi' })) } : c
    ))
    setup({ conversations: withMessages })
    expect(await screen.findByText(`5 msgs · ${fullDateTime(convs[0]!.updatedAt)}`)).toBeInTheDocument()
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
    expect(screen.queryByText(fullDateTime(convs[0]!.updatedAt))).not.toBeInTheDocument()
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

  it('shows a badge on a starred chat, and none on an unstarred one', async () => {
    const starred = convs.map((c) => (c.id === 'a' ? { ...c, starred: true } : c))
    setup({ conversations: starred })
    const row = (await screen.findByText('Astrology forecast')).closest('.conv-row')!
    expect(row.querySelector('.conv-star')).toBeInTheDocument()
    const other = screen.getByText('New chat').closest('.conv-row')!
    expect(other.querySelector('.conv-star')).not.toBeInTheDocument()
  })

  it('badges a temporary chat, so it reads as unsaved without opening it', async () => {
    const temp = convs.map((c) => (c.id === 'a' ? { ...c, temporary: true } : c))
    setup({ conversations: temp })
    const row = (await screen.findByText('Astrology forecast')).closest('.conv-row')!
    expect(row.querySelector('.conv-temporary')).toBeInTheDocument()
    const other = screen.getByText('New chat').closest('.conv-row')!
    expect(other.querySelector('.conv-temporary')).not.toBeInTheDocument()
  })

  it('stars an unstarred chat and unstars a starred one', async () => {
    const user = userEvent.setup()
    const onStar = vi.fn()
    const props = {
      open: true, activeId: 'a', folders: [] as Folder[],
      onOpen: vi.fn(), onDelete: vi.fn(), onRename: vi.fn(), onClose: vi.fn(), onStar,
    }
    const { rerender } = render(<ConversationList {...props} conversations={convs} />)
    await user.click(await screen.findByRole('button', { name: 'Star Astrology forecast' }))
    expect(onStar).toHaveBeenCalledWith('a', true)

    const starred = convs.map((c) => (c.id === 'a' ? { ...c, starred: true } : c))
    rerender(<ConversationList {...props} conversations={starred} />)
    await user.click(await screen.findByRole('button', { name: 'Unstar Astrology forecast' }))
    expect(onStar).toHaveBeenLastCalledWith('a', false)
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

  it('opens the folder picker for the chat whose button was pressed', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('button', { name: /move Astrology forecast to a folder/i }))
    expect(props.onOpenFolderPicker).toHaveBeenCalledWith('a')
  })

  describe('grouped by folder', () => {
    const folders: Folder[] = [{ id: 'f1', name: 'Astrology', createdAt: 1 }, { id: 'f2', name: 'Empty', createdAt: 2 }]

    it('is a flat list, no headers, when nothing is filed', async () => {
      setup({ folders })
      await screen.findByText('Astrology forecast')
      expect(screen.queryByText('Astrology', { selector: '.conv-section-head span' })).not.toBeInTheDocument()
      expect(screen.queryByText('Unfiled')).not.toBeInTheDocument()
    })

    it('groups filed chats under their folder, and the rest under Unfiled', async () => {
      const filed = convs.map((c) => (c.id === 'a' ? { ...c, folderId: 'f1' } : c))
      setup({ folders, conversations: filed })
      expect(await screen.findByText('Astrology', { selector: '.conv-section-head span' })).toBeInTheDocument()
      expect(screen.getByText('Unfiled')).toBeInTheDocument()
      // An empty folder (Empty, f2) gets no section -- nothing to scroll past for it.
      expect(screen.queryByText('Empty')).not.toBeInTheDocument()
    })

    it("starts a new chat in a folder from the + on its header, and closes", async () => {
      const user = userEvent.setup()
      const filed = convs.map((c) => (c.id === 'a' ? { ...c, folderId: 'f1' } : c))
      const onNewChat = vi.fn()
      const props = setup({ folders, conversations: filed, onNewChat })
      await user.click(await screen.findByRole('button', { name: 'New chat in Astrology' }))
      expect(onNewChat).toHaveBeenCalledWith('f1')
      expect(props.onClose).toHaveBeenCalled()
      // Unfiled is a grouping, not a folder: nothing to start "in" it.
      expect(screen.queryByRole('button', { name: /New chat in Unfiled/ })).not.toBeInTheDocument()
    })

    it('treats a folder id that no longer exists as unfiled, rather than dropping the chat', async () => {
      const stale = convs.map((c) => (c.id === 'a' ? { ...c, folderId: 'gone' } : c))
      setup({ folders, conversations: stale })
      expect(await screen.findByText('Astrology forecast')).toBeInTheDocument()
      // Unfiled, alongside "b" -- not its own stray section, and not dropped.
      expect(document.querySelectorAll('.conv-section-head')).toHaveLength(0)
    })
  })

  describe('select mode', () => {
    const many: Conversation[] = [
      { id: 'a', name: 'Astrology forecast', createdAt: now, updatedAt: now - 1, messages: [], responseId: null, folderId: 'f1' },
      { id: 'c', name: 'Transit check', createdAt: now, updatedAt: now - 2, messages: [], responseId: null, folderId: 'f1' },
      { id: 'b', name: 'Grocery list', createdAt: now, updatedAt: now - 3, messages: [], responseId: null },
    ]
    const folders: Folder[] = [{ id: 'f1', name: 'Astrology', createdAt: 1 }]

    it('turns rows into checkboxes, and tapping one selects it rather than opening it', async () => {
      const user = userEvent.setup()
      const props = setup({ conversations: many, folders, onDeleteMany: vi.fn().mockResolvedValue(undefined) })
      await user.click(await screen.findByRole('button', { name: /Select/ }))
      expect(screen.getByText('0 selected')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete/ })).toBeDisabled()
      await user.click(screen.getByRole('checkbox', { name: 'Grocery list' }))
      expect(props.onOpen).not.toHaveBeenCalled()
      expect(screen.getByText('1 selected')).toBeInTheDocument()
      // No per-row actions while selecting: the bar acts on the selection.
      expect(screen.queryByRole('button', { name: /Rename/ })).not.toBeInTheDocument()
    })

    it("selects a whole folder from its header, and all or none from the bar", async () => {
      const user = userEvent.setup()
      setup({ conversations: many, folders, onDeleteMany: vi.fn().mockResolvedValue(undefined) })
      await user.click(await screen.findByRole('button', { name: /Select/ }))
      await user.click(screen.getByRole('checkbox', { name: 'Select every chat in Astrology' }))
      expect(screen.getByRole('checkbox', { name: 'Astrology forecast' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Transit check' })).toBeChecked()
      expect(screen.getByRole('checkbox', { name: 'Grocery list' })).not.toBeChecked()
      expect(screen.getByText('2 selected')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Select all' }))
      expect(screen.getByText('3 selected')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Deselect all' }))
      expect(screen.getByText('0 selected')).toBeInTheDocument()
    })

    it('deletes the selection in one go, and Undo restores every one of them', async () => {
      const user = userEvent.setup()
      const onDeleteMany = vi.fn().mockResolvedValue(undefined)
      const onRestoreMany = vi.fn().mockResolvedValue(undefined)
      setup({ conversations: many, folders, onDeleteMany, onRestoreMany })
      render(<Toaster />)
      await user.click(await screen.findByRole('button', { name: /Select/ }))
      await user.click(screen.getByRole('checkbox', { name: 'Astrology forecast' }))
      await user.click(screen.getByRole('checkbox', { name: 'Grocery list' }))
      await user.click(screen.getByRole('button', { name: 'Delete 2' }))
      expect(onDeleteMany).toHaveBeenCalledWith(['a', 'b'])
      expect(await screen.findByText('2 chats deleted')).toBeInTheDocument()
      const undo = (await screen.findAllByRole('button', { name: 'Undo' }))
        .find((b) => b.closest('[data-sonner-toast]')?.getAttribute('data-index') === '0')!
      fireEvent.click(undo)
      // Oldest first, so the list rebuilds in its original order.
      expect(onRestoreMany).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' }), expect.objectContaining({ id: 'a' })])
    })

    it('leaves select mode with Done, back to the normal list', async () => {
      const user = userEvent.setup()
      setup({ conversations: many, folders, onDeleteMany: vi.fn() })
      await user.click(await screen.findByRole('button', { name: /Select/ }))
      await user.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Rename Grocery list/ })).toBeInTheDocument()
    })

    it('offers no select mode where bulk delete is not wired up', async () => {
      setup()
      await screen.findByText('Astrology forecast')
      expect(screen.queryByRole('button', { name: /Select/ })).not.toBeInTheDocument()
    })
  })
})
