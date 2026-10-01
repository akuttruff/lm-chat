import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import MessageBubble from './MessageBubble'

describe('MessageBubble', () => {
  it('renders assistant markdown as real elements', async () => {
    render(<MessageBubble role="assistant" text={'**bold** and `code`'} model="m" elapsed="1" />)
    expect((await screen.findByText('bold')).tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
  })

  it('renders markdown lists', async () => {
    render(<MessageBubble role="assistant" text={'- one\n- two'} model="m" elapsed="1" />)
    expect(await screen.findAllByRole('listitem')).toHaveLength(2)
  })

  it('renders GFM tables', async () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |'
    render(<MessageBubble role="assistant" text={md} model="m" elapsed="1" />)
    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('does not interpret user text as markdown', () => {
    // A user asking about **syntax** should see the asterisks.
    render(<MessageBubble role="user" text={'**not bold**'} />)
    expect(screen.getByText('**not bold**')).toBeInTheDocument()
  })

  it('shows the serving instance in preference to the model name', () => {
    render(<MessageBubble role="assistant" text="hi" model="qwen" instance="qwen:3" elapsed="2.0" />)
    expect(screen.getByText(/qwen:3/)).toBeInTheDocument()
  })

  it('falls back to the model name when no instance is known', () => {
    render(<MessageBubble role="assistant" text="hi" model="qwen" elapsed="2.0" />)
    expect(screen.getByText(/qwen/)).toBeInTheDocument()
  })

  it("shows what the reply cost in LM Studio's numbers, and when it was cut off", () => {
    const stats = { inputTokens: 9003, outputTokens: 747, reasoningTokens: 497, tokensPerSecond: 19.6, firstTokenSeconds: 1.8 }
    const { rerender } = render(<MessageBubble role="assistant" text="hi" model="qwen" elapsed="38.2" stats={stats} />)
    expect(screen.getByText(/19.6 tok\/s · 9003 in \/ 747 out \(497 thinking\) · 1.8s to first token/)).toBeInTheDocument()
    expect(screen.queryByText(/cut off/)).not.toBeInTheDocument()
    rerender(<MessageBubble role="assistant" text="hi" model="qwen" elapsed="38.2" stats={{ ...stats, inputTokens: 111271, reasoningTokens: 0, capped: true }} />)
    expect(screen.getByText(/111.3K in \/ 747 out · /)).toBeInTheDocument()
    expect(screen.getByText(/cut off at the reply length cap/)).toBeInTheDocument()
  })

  it('renders plain text while streaming, markdown once settled', async () => {
    // Re-parsing a long reply's markdown on every token is quadratic in its
    // length and was the main cost in a big conversation.
    const md = '**bold**'
    const { rerender } = render(
      <MessageBubble role="assistant" text={md} model="m" elapsed="1" streaming />,
    )
    expect(screen.getByText(/\*\*bold\*\*/)).toBeInTheDocument()

    rerender(<MessageBubble role="assistant" text={md} model="m" elapsed="1" />)
    expect((await screen.findByText('bold')).tagName).toBe('STRONG')
  })

  it('hides the meta line while still streaming', () => {
    render(<MessageBubble role="assistant" text="partial" model="qwen" elapsed="2.0" streaming />)
    expect(screen.queryByText(/qwen/)).not.toBeInTheDocument()
  })

  it('marks errors with the error class', () => {
    const { container } = render(<MessageBubble role="error" text="bad" />)
    expect(container.querySelector('.msg.error')).toBeInTheDocument()
  })
})
