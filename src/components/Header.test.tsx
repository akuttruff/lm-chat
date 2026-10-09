import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Header from './Header'

const status = { state: 'live' as const, text: 'connected' }

describe('Header', () => {
  it("shows the open chat's name, and the app's name when there is no chat", () => {
    const { rerender } = render(<Header status={status} startedAt={null} title="Natal chart" onNewChat={vi.fn()} onOpenChats={vi.fn()} />)
    expect(screen.getByText('Natal chart')).toBeInTheDocument()
    rerender(<Header status={status} startedAt={null} onNewChat={vi.fn()} onOpenChats={vi.fn()} />)
    expect(screen.getByText('LM Chat')).toBeInTheDocument()
  })

  it('has a Chats button only when the list is not already on screen', () => {
    const { rerender } = render(<Header status={status} startedAt={null} onNewChat={vi.fn()} onOpenChats={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Chats' })).toBeInTheDocument()
    rerender(<Header status={status} startedAt={null} onNewChat={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Chats' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })
})

describe('renaming from the header', () => {
  it('turns the name into a field; Enter saves a changed name, Escape drops it, an unchanged one is not sent', async () => {
    const user = userEvent.setup()
    const onRename = vi.fn()
    render(<Header status={status} startedAt={null} title="Natal chart" onNewChat={vi.fn()} onOpenChats={vi.fn()} onRename={onRename} />)
    await user.click(screen.getByRole('button', { name: 'Rename chat: Natal chart' }))
    const field = screen.getByRole('textbox', { name: 'Chat name' })
    expect(field).toHaveValue('Natal chart')
    await user.clear(field)
    await user.type(field, 'Birth chart{Enter}')
    expect(onRename).toHaveBeenCalledWith('Birth chart')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Rename chat: Natal chart' }))
    await user.type(screen.getByRole('textbox', { name: 'Chat name' }), ' changed{Escape}')
    expect(onRename).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Rename chat: Natal chart' }))
    await user.type(screen.getByRole('textbox', { name: 'Chat name' }), '{Enter}')
    expect(onRename).toHaveBeenCalledTimes(1)
  })

  it('is plain text when there is nothing to rename', () => {
    render(<Header status={status} startedAt={null} onNewChat={vi.fn()} onOpenChats={vi.fn()} onRename={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Rename chat/ })).not.toBeInTheDocument()
    expect(screen.getByText('LM Chat')).toBeInTheDocument()
  })
})
