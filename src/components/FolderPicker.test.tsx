import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FolderPicker, { describeDefaults } from './FolderPicker.tsx'
import type { Folder, FolderUpdate, PublicConfig } from '../types.ts'

const astrology: Folder = { id: 'f1', name: 'Astrology', createdAt: 1 }
const banter: Folder = { id: 'f2', name: 'Banter', createdAt: 2 }

const config: PublicConfig = {
  lmStudioUrl: '', model: 'qwen', systemPrompt: '', mcpTools: 'mcp/astrology-v2, mcp/deep-research', contextLength: '',
  reasoning: 'low', stallSeconds: '180', historyChars: '24000', parallel: '4', memoryDefault: 'off',
  backgroundModel: '', maxOutputTokens: '', autoTitle: 'on', hasToken: false,
}

function setup(overrides: Partial<Parameters<typeof FolderPicker>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    folders: [astrology, banter],
    currentFolderId: null,
    onAssign: vi.fn(),
    onCreate: vi.fn<(name: string) => Promise<Folder>>(),
    onUpdate: vi.fn<(id: string, patch: FolderUpdate) => Promise<void>>().mockResolvedValue(undefined),
    onDelete: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    config,
    ...overrides,
  }
  render(<FolderPicker {...props} />)
  return props
}

const openEditor = async (user: ReturnType<typeof userEvent.setup>, name = 'Astrology'): Promise<void> => {
  await user.click(await screen.findByRole('button', { name: `Edit ${name}` }))
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
    expect(describeDefaults({ ...astrology, reasoning: 'off', mcpTools: 'mcp/astrology-v2' })).toBe('Reasoning off · Tools: astrology-v2')
    expect(describeDefaults({ ...astrology, mcpTools: '' })).toBe('No tools')
  })

  it("opens a folder's own settings page, titled with its name, and comes back", async () => {
    const user = userEvent.setup()
    setup()
    await openEditor(user)
    expect(screen.getByRole('heading', { name: 'Astrology' })).toBeInTheDocument()
    // The list is out of the way while editing.
    expect(screen.queryByRole('button', { name: 'Banter' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to folders' }))
    expect(await screen.findByRole('button', { name: 'Banter' })).toBeInTheDocument()
  })

  it('renames a folder, leaving its defaults as they were', async () => {
    const user = userEvent.setup()
    const props = setup()
    await openEditor(user)
    const box = screen.getByLabelText('Folder name')
    await user.clear(box)
    await user.type(box, 'Astro')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenCalledWith('f1', { name: 'Astro', reasoning: null, mcpTools: null })
  })

  it("shows what Same as Settings means, sets a folder's reasoning level and turns its tools off", async () => {
    const user = userEvent.setup()
    const props = setup()
    await openEditor(user)
    expect(screen.getByRole('option', { name: 'Same as Settings (low)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Same as Settings (astrology-v2, deep-research)' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Reasoning'), 'off')
    await user.selectOptions(screen.getByLabelText('Tools'), 'none')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // '' for tools is "none" -- distinct from null, which would mean "same as Settings".
    expect(props.onUpdate).toHaveBeenCalledWith('f1', { name: 'Astrology', reasoning: 'off', mcpTools: '' })
  })

  it("picks a folder's tools from a checklist of the ones Settings knows, plus any typed", async () => {
    const user = userEvent.setup()
    const props = setup()
    await openEditor(user)
    await user.selectOptions(screen.getByLabelText('Tools'), 'custom')
    await user.click(screen.getByLabelText('astrology-v2'))
    await user.type(screen.getByLabelText('Other plugin IDs'), 'memory')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenCalledWith('f1', { name: 'Astrology', reasoning: null, mcpTools: 'mcp/astrology-v2, mcp/memory' })
  })

  it("starts from a folder's own tool list, checked", async () => {
    const user = userEvent.setup()
    setup({ folders: [{ ...astrology, reasoning: 'low', mcpTools: 'mcp/astrology-v2' }, banter] })
    expect(await screen.findByText('Reasoning low · Tools: astrology-v2')).toBeInTheDocument()
    await openEditor(user)
    expect(screen.getByLabelText('Tools')).toHaveValue('custom')
    expect(screen.getByLabelText('astrology-v2')).toBeChecked()
    expect(screen.getByLabelText('deep-research')).not.toBeChecked()
  })

  it('deletes a folder from its settings page, after confirming', async () => {
    const user = userEvent.setup()
    const props = setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    await openEditor(user)
    const del = screen.getByRole('button', { name: 'Delete folder' })
    await user.click(del)
    expect(props.onDelete).not.toHaveBeenCalled()
    await user.click(del)
    expect(props.onDelete).toHaveBeenCalledWith('f1')
    confirm.mockRestore()
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
