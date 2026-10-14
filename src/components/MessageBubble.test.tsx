import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import MessageBubble from './MessageBubble'

describe('MessageBubble', () => {
  it("shows a user message's images as thumbnails that open the full image, with no empty bubble for a bare image", () => {
    const images = [{ id: 'img1', name: 'cat.png', mime: 'image/png', bytes: 10 }]
    const { container, rerender } = render(<MessageBubble role="user" text="" images={images} />)
    const img = screen.getByRole('img', { name: 'cat.png' })
    expect(img).toHaveAttribute('src', '/api/images/img1')
    expect(img.closest('a')).toHaveAttribute('href', '/api/images/img1')
    expect(container.querySelector('.bubble')).not.toBeInTheDocument()
    rerender(<MessageBubble role="user" text="what is this" images={images} />)
    expect(screen.getByText('what is this')).toBeInTheDocument()
  })

  it('renders assistant markdown as real elements', async () => {
    render(<MessageBubble role="assistant" text={'**bold** and `code`'} model="m" elapsed="1" />)
    expect((await screen.findByText('bold')).tagName).toBe('STRONG')
    expect(screen.getByText('code').tagName).toBe('CODE')
  })

  it('offers to save a fenced Markdown block as a file, named after its heading', async () => {
    const md = 'Here you go:\n\n```markdown\n# Weekly Meal Plan\n\n- oats\n```\n'
    render(<MessageBubble role="assistant" text={md} model="m" elapsed="1" />)
    const save = await screen.findByRole('button', { name: 'Save as weekly-meal-plan.md' })
    const url = vi.fn<(b: Blob) => string>(() => 'blob:x')
    vi.stubGlobal('URL', { ...URL, createObjectURL: url, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(save)
    expect(url).toHaveBeenCalledTimes(1)
    const blob = url.mock.calls[0]![0] as Blob
    expect(blob.type).toBe('text/markdown')
    expect(await blob.text()).toBe('# Weekly Meal Plan\n\n- oats\n')
    expect(click).toHaveBeenCalled()
    vi.unstubAllGlobals()
    click.mockRestore()
  })

  it('takes a file name written on the fence; a bare fence can be copied but not saved', async () => {
    render(<MessageBubble role="assistant" text={'```csv totals.csv\na,b\n```\n\n```\nplain\n```'} model="m" elapsed="1" />)
    expect(await screen.findByRole('button', { name: 'Save as totals.csv' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy totals.csv' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Save as / })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })

  it('copies just the fenced text, not the words around it', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true })
    render(<MessageBubble role="assistant" text={'Here:\n\n```json\n{"a":1}\n```'} model="m" elapsed="1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy snippet.json' }))
    const { waitFor } = await import('@testing-library/react')
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"a":1}\n'))
  })

  it('offers to save a whole reply as Markdown, named after its first heading', async () => {
    render(<MessageBubble role="assistant" text={'# Grocery List\n\n- eggs'} model="m" elapsed="1" />)
    expect(await screen.findByRole('button', { name: 'Save reply as grocery-list.md' })).toBeInTheDocument()
  })

  it('opens a reply in a full-screen reading view, titled after the chat, and closes it again', async () => {
    render(<MessageBubble id="m1" role="assistant" text={'# Plan\n\nSome **bold** words'} model="m" elapsed="1" title="Weekly planning" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open in reading view' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reading: Weekly planning' })
    expect(dialog).toBeInTheDocument()
    expect((await within(dialog).findByText('bold')).tagName).toBe('STRONG')
    expect(within(dialog).getByRole('button', { name: 'Save reply as plan.md' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open in reading view' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close reading view' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers Share in the reading view only where the browser can share', async () => {
    render(<MessageBubble id="m1" role="assistant" text="hello there" model="m" elapsed="1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open in reading view' }))
    await screen.findByRole('dialog')
    expect(screen.queryByRole('button', { name: 'Share reply' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    const shareFn = vi.fn(async () => {})
    Object.defineProperty(navigator, 'share', { value: shareFn, configurable: true, writable: true })
    fireEvent.click(screen.getByRole('button', { name: 'Open in reading view' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Share reply' }))
    await vi.waitFor(() => expect(shareFn).toHaveBeenCalledWith({ title: 'Reply', text: 'hello there' }))
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true, writable: true })
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

  it('offers to read a finished reply aloud, but not one still being written, nor your own message', () => {
    const { rerender } = render(<MessageBubble id="m1" role="assistant" text="Hello there." model="m" elapsed="1" />)
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument()
    rerender(<MessageBubble id="m1" role="assistant" text="Hello th" streaming />)
    expect(screen.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument()
    rerender(<MessageBubble id="u1" role="user" text="Hi" />)
    expect(screen.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument()
  })

  it('turns the speaker into pause and resume while a reply is read, with a track to drag and a stop beside it', async () => {
    const { Speaker } = await import('../lib/speaker.ts')
    const { default: SpeakButton, SpeechPlayer } = await import('./SpeakButton')
    const { act, fireEvent } = await import('@testing-library/react')
    const audio = { src: '', loop: false, currentTime: 0, duration: 0, play: () => Promise.resolve(), pause: () => {}, onended: null, onerror: null, ontimeupdate: null, ondurationchange: null }
    const track = { name: 't.wav', ready: true, done: 1, total: 1, url: '/api/speech/tracks/t.wav', seconds: 90 }
    const player = new Speaker(
      (async () => new Response(JSON.stringify(track))) as unknown as typeof fetch,
      () => audio as unknown as HTMLAudioElement, () => {}, null, 0,
    )
    render(<><SpeakButton id="m1" text="Hello there." player={player} /><SpeechPlayer id="m1" player={player} /></>)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Read aloud' })); await new Promise((r) => setTimeout(r, 10)) })
    expect(screen.getAllByRole('button', { name: 'Pause reading aloud' })).toHaveLength(2)
    expect(screen.getByText('0:00 / 1:30')).toBeInTheDocument()
    // Dragging the bar shows where it will go, and seeks once the finger lifts.
    const slider = screen.getByRole('slider', { name: 'Position in the reading' })
    act(() => { fireEvent.change(slider, { target: { value: '45' } }) })
    expect(screen.getByText('0:45 / 1:30')).toBeInTheDocument()
    expect(audio.currentTime).toBe(0)
    act(() => { fireEvent.pointerUp(slider) })
    expect(audio.currentTime).toBe(45)
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Forward 15 seconds' })) })
    expect(audio.currentTime).toBe(60)
    expect(screen.getByText('1:00 / 1:30')).toBeInTheDocument()
    act(() => { fireEvent.click(screen.getAllByRole('button', { name: 'Pause reading aloud' })[0]!) })
    expect(screen.getAllByRole('button', { name: 'Resume reading aloud' })).toHaveLength(2)
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Stop reading aloud' })) })
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('copies a reply as Markdown, and says so for a moment', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<MessageBubble id="m1" role="assistant" text={'**bold** reply'} model="m" elapsed="1" />)
    const { fireEvent, act } = await import('@testing-library/react')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy reply' })) })
    expect(writeText).toHaveBeenCalledWith('**bold** reply')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
