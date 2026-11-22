import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FolderPicker, { describeDefaults } from './FolderPicker.tsx'
import type { Folder } from '../types.ts'

const astrology: Folder = { id: 'f1', name: 'Astrology', createdAt: 1 }
const banter: Folder = { id: 'f2', name: 'Banter', createdAt: 2 }

function setup(overrides: Partial<Parameters<typeof FolderPicker>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    folders: [astrology, banter],
    currentFolderId: null,
    onAssign: vi.fn(),
    onCreate: vi.fn<(name: string) => Promise<Folder>>(),
    ...overrides,
  }
  render(<FolderPicker {...props} />)
  return props
}

describe('FolderPicker', () => {
  it('lists every folder plus "No folder", checking the current one', async () => {
    setup({ currentFolderId: 'f2' })
    const noFolder = await screen.findByRole('button', { name: 'No folder' })
    const banterRow = screen.getByRole('button', { name: 'Banter' })
    expect(noFolder.querySelector('svg')).not.toBeInTheDocument()
    expect(banterRow.querySelector('svg')).toBeInTheDocument()
  })

  it('assigns the tapped folder and closes', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('button', { name: 'Astrology' }))
    expect(props.onAssign).toHaveBeenCalledWith('f1')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('clears the folder when "No folder" is tapped', async () => {
    const user = userEvent.setup()
    const props = setup({ currentFolderId: 'f1' })
    await user.click(await screen.findByRole('button', { name: 'No folder' }))
    expect(props.onAssign).toHaveBeenCalledWith(null)
  })

  it('says under each folder what it changes for its chats, in words', () => {
    expect(describeDefaults(astrology)).toBe('')
    expect(describeDefaults({ ...astrology, reasoning: 'off' })).toBe('Reasoning off')
    // Old tool and memory defaults no longer change anything, so they aren't mentioned.
    expect(describeDefaults({ ...astrology, mcpTools: 'mcp/astrology-v2', memory: false })).toBe('')
  })

  it('only files chats: no folder settings here, they live on the chat list', async () => {
    setup()
    await screen.findByRole('button', { name: 'Astrology' })
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
  })

  it('creates a folder from the typed name and immediately files the chat into it', async () => {
    const user = userEvent.setup()
    const created: Folder = { id: 'f3', name: 'New one', createdAt: 3 }
    const props = setup({ onCreate: vi.fn<(name: string) => Promise<Folder>>().mockResolvedValue(created) })
    await user.type(await screen.findByLabelText('New folder name'), 'New one')
    await user.click(screen.getByRole('button', { name: 'Create folder' }))
    expect(props.onCreate).toHaveBeenCalledWith('New one')
    expect(props.onAssign).toHaveBeenCalledWith('f3')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('disables creating until something is typed', async () => {
    setup()
    expect(await screen.findByRole('button', { name: 'Create folder' })).toBeDisabled()
  })
})
