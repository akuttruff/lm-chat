import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolPicker from './ToolPicker.tsx'

const catalog = {
  fetchedAt: 1,
  servers: [
    { id: 'mcp/astrology-v2', name: 'astrology-v2', tools: [
      { name: 'create_natal_chart', description: 'Generate a natal chart.' },
      { name: 'verify_claim', description: 'Check one transit claim.' },
      { name: 'list_upcoming_transits', description: 'List dated transits.' },
    ] },
    { id: 'mcp/deep-research', name: 'deep-research', tools: [
      { name: 'web_search', description: 'Search the web.' },
    ] },
  ],
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(catalog) })))
})

function setup(overrides: Partial<Parameters<typeof ToolPicker>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    value: null as string | null,
    inherited: 'mcp/astrology-v2, mcp/deep-research',
    inheritedFrom: 'Settings' as const,
    onChange: vi.fn(),
    ...overrides,
  }
  render(<ToolPicker {...props} />)
  return props
}

describe('ToolPicker', () => {
  it('starts on "same as Settings", describing what that means', async () => {
    setup()
    expect(await screen.findByRole('radio', { name: /Same as Settings/ })).toBeChecked()
    expect(screen.getByText('astrology-v2, deep-research')).toBeInTheDocument()
  })

  it('lists every server and tool the servers reported, with the inherited ones ticked', async () => {
    const user = userEvent.setup()
    setup({ inherited: 'mcp/astrology-v2(verify_claim), mcp/deep-research' })
    await user.click(await screen.findByRole('radio', { name: /Choose for this chat/ }))
    const astro = await screen.findByRole('region', { name: 'astrology-v2' })
    expect(within(astro).getByText('1 of 3')).toBeInTheDocument()
    expect(within(astro).getByRole('checkbox', { name: /verify_claim/ })).toBeChecked()
    expect(within(astro).getByRole('checkbox', { name: /create_natal_chart/ })).not.toBeChecked()
    const research = screen.getByRole('region', { name: 'deep-research' })
    expect(within(research).getByRole('checkbox', { name: /web_search/ })).toBeChecked()
  })

  it("saves a chat's own list: chosen tools in parentheses, a whole server plain, an unticked server left out", async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('radio', { name: /Choose for this chat/ }))
    const astro = await screen.findByRole('region', { name: 'astrology-v2' })
    // Everything is ticked (inherited "all"); untick two astrology tools and all of deep-research.
    await user.click(within(astro).getByRole('checkbox', { name: /create_natal_chart/ }))
    await user.click(within(astro).getByRole('checkbox', { name: /list_upcoming_transits/ }))
    const research = screen.getByRole('region', { name: 'deep-research' })
    await user.click(within(research).getByRole('checkbox', { name: /web_search/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onChange).toHaveBeenCalledWith('mcp/astrology-v2(verify_claim)')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('ticking every tool of a server stores it plain, so tools the server adds later are offered too', async () => {
    const user = userEvent.setup()
    const props = setup({ value: 'mcp/astrology-v2(verify_claim)' })
    const astro = await screen.findByRole('region', { name: 'astrology-v2' })
    await user.click(within(astro).getByRole('checkbox', { name: /create_natal_chart/ }))
    await user.click(within(astro).getByRole('checkbox', { name: /list_upcoming_transits/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onChange).toHaveBeenCalledWith('mcp/astrology-v2')
  })

  it('goes back to the inherited list when "same as" is chosen again', async () => {
    const user = userEvent.setup()
    const props = setup({ value: 'mcp/deep-research', inheritedFrom: 'folder' })
    await user.click(await screen.findByRole('radio', { name: /Same as folder/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onChange).toHaveBeenCalledWith(null)
  })

  it('deselects everything at once, and selects everything at once', async () => {
    const user = userEvent.setup()
    const props = setup({ value: 'mcp/astrology-v2(verify_claim)' })
    await screen.findByRole('region', { name: 'astrology-v2' })
    await user.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(screen.getByRole('checkbox', { name: /verify_claim/ })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onChange).toHaveBeenCalledWith('') // a chat with no tools, as a choice
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('checkbox', { name: /web_search/ })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onChange).toHaveBeenLastCalledWith('mcp/astrology-v2, mcp/deep-research')
  })

  it('re-asks the servers on request', async () => {
    const user = userEvent.setup()
    setup({ value: '' })
    await screen.findByRole('region', { name: 'astrology-v2' })
    await user.click(screen.getByRole('button', { name: /Re-ask the servers/ }))
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes('refresh=1'))).toBe(true))
  })
})
