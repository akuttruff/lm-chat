import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Composer from './Composer.tsx'

describe('memory chip', () => {
  it('shows whether memory is on for this chat, and toggles it', async () => {
    const user = userEvent.setup()
    const onToggleMemory = vi.fn()
    const { rerender } = render(<Composer onSend={vi.fn()} memoryOn={false} onToggleMemory={onToggleMemory} />)
    const chip = screen.getByRole('button', { name: 'Memory off for this chat' })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await user.click(chip)
    expect(onToggleMemory).toHaveBeenCalledTimes(1)
    rerender(<Composer onSend={vi.fn()} memoryOn onToggleMemory={onToggleMemory} />)
    expect(screen.getByRole('button', { name: 'Memory on for this chat' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('is absent when there is no chat to set it on', () => {
    render(<Composer onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /memory/i })).not.toBeInTheDocument()
  })
})
