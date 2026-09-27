import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChatThread from './ChatThread.tsx'
import type { Message } from '../types.ts'

/**
 * jsdom does no layout, so scroll metrics have to be supplied. These model a
 * thread 1000px tall in a 400px viewport.
 */
const CONTENT = 1000
const VIEWPORT = 400
const BOTTOM = CONTENT - VIEWPORT // 600: scrollTop when pinned to the bottom

function thread(): HTMLElement {
  return document.querySelector('.thread') as HTMLElement
}

/** Give the scroll container measurable dimensions. */
function measure(el: HTMLElement, scrollTop = BOTTOM): void {
  Object.defineProperty(el, 'scrollHeight', { value: CONTENT, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: VIEWPORT, configurable: true })
  el.scrollTop = scrollTop
}

/** Scroll the container and fire the event React listens for. */
function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top
  fireEvent.scroll(el)
}

const msg = (id: string, role: Message['role'] = 'assistant', text = id): Message =>
  ({ id, role, text })

const HISTORY: Message[] = [
  msg('1', 'user', 'my question'),
  msg('2', 'assistant', 'an answer'),
]

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn(function (this: HTMLElement, opts) {
    if (opts && typeof opts === 'object' && 'top' in opts) {
      this.scrollTop = Number(opts.top)
    }
  }) as typeof Element.prototype.scrollTo
})

describe('following the newest message', () => {
  it('scrolls to the bottom when already there', () => {
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    rerender(<ChatThread messages={[...HISTORY, msg('3', 'assistant', 'more')]} />)
    expect(el.scrollTop).toBe(CONTENT)
  })

  it('leaves the view alone when scrolled up', () => {
    // The reported bug: reading back through a conversation was impossible
    // because every streamed token yanked the view to the bottom.
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    scrollTo(el, 100) // scroll up to read

    rerender(<ChatThread messages={[...HISTORY, msg('3', 'assistant', 'more')]} />)
    expect(el.scrollTop).toBe(100)
  })

  it('keeps ignoring token after token while you read', () => {
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    scrollTo(el, 100)

    for (const text of ['a', 'ab', 'abc', 'abcd']) {
      rerender(<ChatThread messages={[...HISTORY, msg('3', 'assistant', text)]} />)
      expect(el.scrollTop).toBe(100)
    }
  })

  it('counts near-the-bottom as following', () => {
    // A few pixels of slack: the last line grows as tokens arrive.
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM - 40)
    scrollTo(el, BOTTOM - 40)
    rerender(<ChatThread messages={[...HISTORY, msg('3')]} />)
    expect(el.scrollTop).toBe(CONTENT)
  })

  it('resumes following once you scroll back down', () => {
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    scrollTo(el, 100)
    rerender(<ChatThread messages={[...HISTORY, msg('3')]} />)
    expect(el.scrollTop).toBe(100)

    scrollTo(el, BOTTOM) // back to the bottom
    rerender(<ChatThread messages={[...HISTORY, msg('4')]} />)
    expect(el.scrollTop).toBe(CONTENT)
  })

  it('always follows your own message', () => {
    // Sending is a request to see it, wherever you were reading.
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    scrollTo(el, 100)
    rerender(<ChatThread messages={[...HISTORY, msg('3', 'user', 'next question')]} />)
    expect(el.scrollTop).toBe(CONTENT)
  })
})

describe('jump to latest', () => {
  it('is hidden while following', () => {
    render(<ChatThread messages={HISTORY} />)
    measure(thread(), BOTTOM)
    expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeInTheDocument()
  })

  it('appears once you scroll away', () => {
    render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    scrollTo(el, 100)
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument()
  })

  it('returns you to the bottom and resumes following', () => {
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    const el = thread()
    measure(el, BOTTOM)
    scrollTo(el, 100)

    fireEvent.click(screen.getByRole('button', { name: /jump to latest/i }))
    expect(el.scrollTop).toBe(CONTENT)

    // And new content follows again.
    measure(el, BOTTOM)
    rerender(<ChatThread messages={[...HISTORY, msg('3')]} />)
    expect(el.scrollTop).toBe(CONTENT)
  })
})

describe('empty state', () => {
  it('still renders with no messages', () => {
    render(<ChatThread messages={[]} />)
    expect(screen.getByText(/start chatting from anywhere/i)).toBeInTheDocument()
  })
})

describe('auto-compaction summary', () => {
  it('marks where the summary ends and expands to show it', () => {
    render(<ChatThread messages={HISTORY} summary={{ text: '- asked a question', through: '1' }} />)
    const toggle = screen.getByRole('button', { name: /earlier turns summarized/i })
    // After the message it covers, before the next.
    const rows = [...document.querySelectorAll('.msg-row')]
    expect(rows.findIndex((r) => r.contains(toggle))).toBe(1)
    expect(screen.queryByText('- asked a question')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('- asked a question')).toBeTruthy()
  })

  it('shows nothing without a summary, or when its anchor is gone', () => {
    const { rerender } = render(<ChatThread messages={HISTORY} />)
    expect(screen.queryByText(/earlier turns summarized/i)).toBeNull()
    rerender(<ChatThread messages={HISTORY} summary={{ text: 'x', through: 'missing' }} />)
    expect(screen.queryByText(/earlier turns summarized/i)).toBeNull()
  })
})

describe('long threads', () => {
  const many = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', `message ${i}`))

  it('draws only the latest messages at first, and the rest on request', () => {
    render(<ChatThread messages={many(100)} />)
    expect(screen.queryByText('message 0')).toBeNull()
    expect(screen.getByText('message 99')).toBeTruthy()
    expect(document.querySelectorAll('.msg-row')).toHaveLength(40)
    fireEvent.click(screen.getByRole('button', { name: /Show 60 earlier messages/ }))
    expect(screen.getByText('message 0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /earlier/ })).toBeNull()
  })

  it('shows no button for a short thread', () => {
    render(<ChatThread messages={many(10)} />)
    expect(screen.queryByRole('button', { name: /earlier/ })).toBeNull()
  })
})
