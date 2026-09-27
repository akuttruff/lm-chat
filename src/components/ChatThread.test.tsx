import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChatThread from './ChatThread.tsx'
import { loadScrollAnchor, saveScrollAnchor } from '../lib/scrollMemory.ts'
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
  // Tests that don't pass conversationId all share the 'default' key, and
  // scroll-memory tests reuse ids across cases -- neither should see what an
  // earlier test left behind.
  localStorage.clear()
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

describe('remembering where you left off', () => {
  const many = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(`m${i}`, 'assistant', `message ${i}`))
  const ROW = 50
  const VIEWPORT = 200

  // jsdom computes no layout at all (offsetTop, scrollHeight... are always
  // 0), including during the component's own scroll-restoring effects,
  // which run synchronously within render() -- too early for a per-test
  // snapshot taken afterwards to matter. These are live getters instead, so
  // whatever reads them mid-render sees numbers that track the rendered
  // rows, the same as a real layout would.
  let restoreOffsetTop: PropertyDescriptor
  let restoreOffsetHeight: PropertyDescriptor
  let restoreScrollHeight: PropertyDescriptor
  let restoreClientHeight: PropertyDescriptor

  beforeEach(() => {
    restoreOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!
    restoreOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    restoreScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!
    restoreClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!

    const rowsOf = (el: Element): HTMLElement[] => [...el.querySelectorAll<HTMLElement>('[data-msg-id]')]

    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get(this: HTMLElement) {
        const container = this.dataset.msgId && this.closest('.thread')
        return container ? rowsOf(container).indexOf(this) * ROW : 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.dataset.msgId ? ROW : 0 },
    })
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get(this: Element) { return this.classList.contains('thread') ? rowsOf(this).length * ROW : 0 },
    })
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) { return this.classList.contains('thread') ? VIEWPORT : 0 },
    })
  })

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', restoreOffsetTop)
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', restoreOffsetHeight)
    Object.defineProperty(Element.prototype, 'scrollHeight', restoreScrollHeight)
    Object.defineProperty(Element.prototype, 'clientHeight', restoreClientHeight)
  })

  it('restores the reading position after switching away and back', () => {
    const messages = many(10)
    const { unmount } = render(<ChatThread messages={messages} conversationId="c1" />)
    const el = thread()
    scrollTo(el, 120) // reading around message 2 (rows 100-150)
    unmount() // switching conversations flushes at once, no need to wait

    render(<ChatThread messages={messages} conversationId="c1" />)
    expect(thread().scrollTop).toBe(120)
  })

  it('keeps different conversations apart', () => {
    const messages = many(10)
    const { unmount } = render(<ChatThread messages={messages} conversationId="c1" />)
    scrollTo(thread(), 120)
    unmount()

    render(<ChatThread messages={messages} conversationId="c2" />)
    // Nothing saved for c2: the usual default, the bottom.
    const el = thread()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('goes back to the bottom next time once you scroll there before leaving', () => {
    const messages = many(10)
    const { unmount } = render(<ChatThread messages={messages} conversationId="c1" />)
    const el = thread()
    scrollTo(el, 120) // scroll up to read
    scrollTo(el, el.scrollHeight) // then back down: caught up
    unmount()

    render(<ChatThread messages={messages} conversationId="c1" />)
    const el2 = thread()
    expect(el2.scrollTop).toBe(el2.scrollHeight)
  })

  it('widens the initial window so a saved position further back than the default is already there to see', () => {
    const messages = many(100)
    saveScrollAnchor('c1', { anchorId: 'm0', offset: 0 })
    render(<ChatThread messages={messages} conversationId="c1" />)
    expect(screen.getByText('message 0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /earlier/ })).toBeNull() // no need to ask for more
    expect(thread().scrollTop).toBe(0)
  })

  it('falls back to the bottom when the saved message is no longer in the thread', () => {
    saveScrollAnchor('c1', { anchorId: 'gone', offset: 40 })
    const messages = many(10)
    render(<ChatThread messages={messages} conversationId="c1" />)
    const el = thread()
    expect(el.scrollTop).toBe(el.scrollHeight)
  })

  it('saves on its own after a pause in scrolling, not only when you switch away', () => {
    vi.useFakeTimers()
    try {
      const messages = many(10)
      render(<ChatThread messages={messages} conversationId="c1" />)
      scrollTo(thread(), 120)
      expect(loadScrollAnchor('c1')).toBeNull() // not yet -- still mid-scroll
      vi.advanceTimersByTime(500)
      expect(loadScrollAnchor('c1')).toEqual({ anchorId: 'm2', offset: 20 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes when the app is hidden, not only when the thread unmounts', () => {
    const messages = many(10)
    render(<ChatThread messages={messages} conversationId="c1" />)
    scrollTo(thread(), 120)
    expect(loadScrollAnchor('c1')).toBeNull()

    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    fireEvent(document, new Event('visibilitychange'))
    expect(loadScrollAnchor('c1')).toEqual({ anchorId: 'm2', offset: 20 })
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })
})
