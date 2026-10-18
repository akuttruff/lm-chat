import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FolderPicker, { describeDefaults } from './FolderPicker.tsx'
import type { Folder, FolderUpdate, PublicConfig } from '../types.ts'

const astrology: Folder = { id: 'f1', name: 'Astrology', createdAt: 1 }
const banter: Folder = { id: 'f2', name: 'Banter', createdAt: 2 }

// What the servers report when the editor asks for their tools.
const catalog = {
  fetchedAt: 1,
  servers: [
    { id: 'mcp/astrology-v2', name: 'astrology-v2', tools: [
      { name: 'create_natal_chart', description: 'Generate a natal chart.' },
      { name: 'verify_claim', description: 'Check one transit claim.' },
      { name: 'forecast_month', description: 'A month ahead.' },
    ] },
    { id: 'mcp/deep-research', name: 'deep-research', tools: [
      { name: 'web_search', description: 'Search the web.' },
    ] },
  ],
}

const memories = [
  { id: 'a1', text: 'Favorite color is green', createdAt: 1, updatedAt: 1 },
  { id: 'b2', text: 'Born June 15, 1990', createdAt: 2, updatedAt: 2 },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
    ok: true, json: () => Promise.resolve(String(url).startsWith('/api/memories') ? memories : catalog),
  })))
})

const config: PublicConfig = {
  lmStudioUrl: '', model: 'qwen', systemPrompt: '', mcpTools: 'mcp/astrology-v2, mcp/deep-research', contextLength: '',
  reasoning: 'low', stallSeconds: '180', historyChars: '24000', parallel: '4', memoryDefault: 'off',
  backgroundModel: '', maxOutputTokens: '', autoTitle: 'on', speechVoice: 'af_heart', speechSpeed: '1', hasToken: false,
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
    expect(describeDefaults({ ...astrology, mcpTools: 'mcp/astrology-v2(verify_claim, forecast_month), mcp/deep-research' }))
      .toBe('Tools: astrology-v2 (2), deep-research')
    expect(describeDefaults({ ...astrology, memory: false })).toBe('Memory off')
    expect(describeDefaults({ ...astrology, memory: true, memorySelection: ['a1', 'b2'] })).toBe('Memory on (2 picked)')
    expect(describeDefaults({ ...astrology, memorySelection: ['a1'] })).toBe('1 memory picked')
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
    expect(props.onUpdate).toHaveBeenCalledWith('f1', { name: 'Astro', reasoning: null, mcpTools: null, memory: null, memorySelection: null })
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
    expect(props.onUpdate).toHaveBeenCalledWith('f1', {
      name: 'Astrology', reasoning: 'off', mcpTools: '', memory: null, memorySelection: null,
    })
  })

  it("turns a folder's memory on and picks which memories its chats start with", async () => {
    const user = userEvent.setup()
    const props = setup()
    await openEditor(user)
    expect(screen.getByRole('option', { name: 'Same as Settings (off)' })).toBeInTheDocument()
    // Memory is off (Settings' default), so there is nothing to pick from yet.
    expect(screen.queryByLabelText('Memories')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Memory'), 'on')
    await user.selectOptions(screen.getByLabelText('Memories'), 'custom')
    // "Only these" starts from every memory; untick one.
    expect(await screen.findByLabelText('Favorite color is green')).toBeChecked()
    await user.click(screen.getByLabelText('Favorite color is green'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenCalledWith('f1', {
      name: 'Astrology', reasoning: null, mcpTools: null, memory: true, memorySelection: ['b2'],
    })
  })

  it("starts from a folder's own memory pick, and 'automatic' clears it", async () => {
    const user = userEvent.setup()
    const props = setup({ folders: [{ ...astrology, memory: true, memorySelection: ['b2'] }, banter] })
    expect(await screen.findByText('Memory on (1 picked)')).toBeInTheDocument()
    await openEditor(user)
    expect(screen.getByLabelText('Memory')).toHaveValue('on')
    expect(screen.getByLabelText('Memories')).toHaveValue('custom')
    expect(await screen.findByLabelText('Born June 15, 1990')).toBeChecked()
    expect(screen.getByLabelText('Favorite color is green')).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(screen.getByLabelText('Born June 15, 1990')).not.toBeChecked()
    await user.selectOptions(screen.getByLabelText('Memories'), 'auto')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenCalledWith('f1', {
      name: 'Astrology', reasoning: null, mcpTools: null, memory: true, memorySelection: null,
    })
  })

  it("picks a folder's tools one by one from the servers' own lists, starting from what Settings gives", async () => {
    const user = userEvent.setup()
    const props = setup()
    await openEditor(user)
    await user.selectOptions(screen.getByLabelText('Tools'), 'custom')
    // Settings offers both servers whole, so everything starts ticked; keep two astrology tools and drop deep-research.
    const astro = await screen.findByRole('region', { name: 'astrology-v2' })
    expect(within(astro).getByText('3 of 3')).toBeInTheDocument()
    await user.click(within(astro).getByRole('checkbox', { name: /create_natal_chart/ }))
    const research = screen.getByRole('region', { name: 'deep-research' })
    await user.click(within(research).getByRole('checkbox', { name: /web_search/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenCalledWith('f1', {
      name: 'Astrology', reasoning: null, mcpTools: 'mcp/astrology-v2(forecast_month, verify_claim)', memory: null, memorySelection: null,
    })
  })

  it("starts from a folder's own tool subset, with just those ticked", async () => {
    const user = userEvent.setup()
    setup({ folders: [{ ...astrology, reasoning: 'low', mcpTools: 'mcp/astrology-v2(verify_claim)' }, banter] })
    expect(await screen.findByText('Reasoning low · Tools: astrology-v2 (1)')).toBeInTheDocument()
    await openEditor(user)
    expect(screen.getByLabelText('Tools')).toHaveValue('custom')
    const astro = await screen.findByRole('region', { name: 'astrology-v2' })
    expect(within(astro).getByText('1 of 3')).toBeInTheDocument()
    expect(within(astro).getByRole('checkbox', { name: /verify_claim/ })).toBeChecked()
    expect(within(astro).getByRole('checkbox', { name: /create_natal_chart/ })).not.toBeChecked()
    expect(within(screen.getByRole('region', { name: 'deep-research' })).getByRole('checkbox', { name: /web_search/ })).not.toBeChecked()
  })

  it('ticking a whole server stores it plain, and deselect all empties the list', async () => {
    const user = userEvent.setup()
    const props = setup({ folders: [{ ...astrology, mcpTools: 'mcp/astrology-v2(verify_claim)' }, banter] })
    await openEditor(user)
    const astro = await screen.findByRole('region', { name: 'astrology-v2' })
    await user.click(within(astro).getByRole('checkbox', { name: /^astrology-v2/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenLastCalledWith('f1', expect.objectContaining({ mcpTools: 'mcp/astrology-v2' }))
    // Saving goes back to the list; open the editor again for the second change.
    await openEditor(user)
    await user.click(await screen.findByRole('button', { name: 'Deselect all' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onUpdate).toHaveBeenLastCalledWith('f1', expect.objectContaining({ mcpTools: '' }))
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
