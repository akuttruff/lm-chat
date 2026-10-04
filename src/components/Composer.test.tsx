import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Composer from './Composer.tsx'

// jsdom has no canvas, so prepareImage sends files as they are; a PNG header is image enough.
const pngFile = (name = 'cat.png'): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })

describe('images', () => {
  it('attaches a chosen image, shows it, and sends it with the text', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await user.upload(screen.getByLabelText('Choose images'), pngFile())
    expect(await screen.findByRole('img', { name: 'cat.png' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
    await user.type(screen.getByPlaceholderText(/about the image/), 'what is this')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('what is this', [expect.objectContaining({ name: 'cat.png', mime: 'image/png' })])
    expect(screen.queryByRole('img')).not.toBeInTheDocument() // cleared with the text
  })

  it('sends an image on its own, and removes one before sending', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await user.upload(screen.getByLabelText('Choose images'), [pngFile('a.png'), pngFile('b.png')])
    await screen.findByRole('img', { name: 'b.png' })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Remove a.png' }))
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('', [expect.objectContaining({ name: 'b.png' })])
  })

  it('takes an image pasted into the message box', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const box = screen.getByPlaceholderText('Message')
    await user.click(box)
    await user.paste({ getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => pngFile('shot.png') }] } as unknown as DataTransfer)
    expect(await screen.findByRole('img', { name: 'shot.png' })).toBeInTheDocument()
  })

  it('ignores files that are not images, and says so', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    await user.upload(screen.getByLabelText('Choose images'), new File(['hi'], 'notes.txt', { type: 'text/plain' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

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

  it('fills the brain icon on, outlines it off, so on/off is not just a color', () => {
    const { container, rerender } = render(<Composer onSend={vi.fn()} memoryOn={false} onToggleMemory={vi.fn()} />)
    expect(container.querySelector('.memory-chip svg')).toHaveAttribute('fill', 'none')
    rerender(<Composer onSend={vi.fn()} memoryOn onToggleMemory={vi.fn()} />)
    expect(container.querySelector('.memory-chip svg')).toHaveAttribute('fill', 'currentColor')
  })

  it('is absent when there is no chat to set it on', () => {
    render(<Composer onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /memory/i })).not.toBeInTheDocument()
  })
})

describe('memory picker chip', () => {
  it('appears only while memory is on for this chat, and opens the picker', async () => {
    const user = userEvent.setup()
    const onPickMemories = vi.fn()
    const { rerender } = render(
      <Composer onSend={vi.fn()} memoryOn={false} onToggleMemory={vi.fn()} onPickMemories={onPickMemories} />,
    )
    expect(screen.queryByRole('button', { name: /choose which memories/i })).not.toBeInTheDocument()

    rerender(<Composer onSend={vi.fn()} memoryOn onToggleMemory={vi.fn()} onPickMemories={onPickMemories} />)
    const chip = screen.getByRole('button', { name: /choose which memories/i })
    await user.click(chip)
    expect(onPickMemories).toHaveBeenCalledTimes(1)
  })

  it('stays absent with memory on if nothing wired it up', () => {
    render(<Composer onSend={vi.fn()} memoryOn onToggleMemory={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /choose which memories/i })).not.toBeInTheDocument()
  })
})

describe('temporary chip', () => {
  it('shows whether this chat is temporary, and toggles it', async () => {
    const user = userEvent.setup()
    const onToggleTemporary = vi.fn()
    const { rerender } = render(<Composer onSend={vi.fn()} temporaryOn={false} onToggleTemporary={onToggleTemporary} />)
    const chip = screen.getByRole('button', { name: /save this chat normally/i })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    await user.click(chip)
    expect(onToggleTemporary).toHaveBeenCalledTimes(1)
    rerender(<Composer onSend={vi.fn()} temporaryOn onToggleTemporary={onToggleTemporary} />)
    expect(screen.getByRole('button', { name: /nothing is being saved/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('fills the ghost icon on, outlines it off, so on/off is not just a color', () => {
    const { container, rerender } = render(<Composer onSend={vi.fn()} temporaryOn={false} onToggleTemporary={vi.fn()} />)
    expect(container.querySelector('.temporary-chip svg')).toHaveAttribute('fill', 'none')
    rerender(<Composer onSend={vi.fn()} temporaryOn onToggleTemporary={vi.fn()} />)
    expect(container.querySelector('.temporary-chip svg')).toHaveAttribute('fill', 'currentColor')
  })

  it('is absent when there is no chat to set it on', () => {
    render(<Composer onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /temporary/i })).not.toBeInTheDocument()
  })
})

describe('folder chip', () => {
  it('shows the chat\'s folder, or "Folder" when it has none, and opens the picker', async () => {
    const user = userEvent.setup()
    const onOpenFolderPicker = vi.fn()
    const { rerender } = render(<Composer onSend={vi.fn()} folderLabel="Folder" onOpenFolderPicker={onOpenFolderPicker} />)
    expect(screen.getByRole('button', { name: 'Folder: Folder' })).toHaveTextContent('Folder')

    rerender(<Composer onSend={vi.fn()} folderLabel="Astrology" onOpenFolderPicker={onOpenFolderPicker} />)
    const chip = screen.getByRole('button', { name: 'Folder: Astrology' })
    await user.click(chip)
    expect(onOpenFolderPicker).toHaveBeenCalledTimes(1)
  })

  it('is absent when there is no chat to file', () => {
    render(<Composer onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Folder:/ })).not.toBeInTheDocument()
  })
})
