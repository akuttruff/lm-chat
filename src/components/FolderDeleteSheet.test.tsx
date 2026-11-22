import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FolderDeleteSheet from './FolderDeleteSheet.tsx'

const folder = { id: 'f1', name: 'Tarot', createdAt: 1 }

describe('FolderDeleteSheet', () => {
  it('asks what happens to the chats: keep them, the first choice, or delete them too', async () => {
    const user = userEvent.setup()
    const onKeepChats = vi.fn()
    const onDeleteChats = vi.fn()
    const onClose = vi.fn()
    render(<FolderDeleteSheet target={{ folder, count: 5 }} onKeepChats={onKeepChats} onDeleteChats={onDeleteChats} onClose={onClose} />)
    expect(await screen.findByText('Delete “Tarot”?')).toBeInTheDocument()
    const [keep, del] = screen.getAllByRole('button').filter((b) => /Delete folder/.test(b.textContent ?? ''))
    expect(keep).toHaveTextContent('Delete folder, keep its 5 chats')
    expect(del).toHaveTextContent('Delete folder and its 5 chats')
    await user.click(keep!)
    expect(onKeepChats).toHaveBeenCalled()
    await user.click(del!)
    expect(onDeleteChats).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('says "1 chat", not "1 chats"', async () => {
    render(<FolderDeleteSheet target={{ folder, count: 1 }} onKeepChats={vi.fn()} onDeleteChats={vi.fn()} onClose={vi.fn()} />)
    expect(await screen.findByText(/keep its 1 chat$/)).toBeInTheDocument()
  })

  it('is closed with no folder to delete', () => {
    render(<FolderDeleteSheet target={null} onKeepChats={vi.fn()} onDeleteChats={vi.fn()} onClose={vi.fn()} />)
    expect(screen.queryByText(/Delete “/)).not.toBeInTheDocument()
  })
})
