import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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
