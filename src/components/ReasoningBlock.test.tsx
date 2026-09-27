import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReasoningBlock from './ReasoningBlock'

describe('ReasoningBlock', () => {
  it('hides the thought behind a collapsed toggle', () => {
    render(<ReasoningBlock text="secret reasoning" elapsed="2.0" />)
    expect(screen.queryByText('secret reasoning')).not.toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  it('reveals the thought when expanded', async () => {
    const user = userEvent.setup()
    render(<ReasoningBlock text="secret reasoning" elapsed="2.0" />)
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText('secret reasoning')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows the duration once finished', () => {
    render(<ReasoningBlock text="x" elapsed="4.2" />)
    expect(screen.getByText('Thought for 4.2s')).toBeInTheDocument()
  })

  it('says it is thinking while streaming', () => {
    render(<ReasoningBlock text="partial" streaming />)
    expect(screen.getByText('Thinking...')).toBeInTheDocument()
  })
})
