import { describe, it, expect, vi } from 'vitest'
import type { Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SettingsSheet from './SettingsSheet.tsx'
import type { ModelConfig, PublicConfig } from '../types.ts'

const base: PublicConfig = {
  lmStudioUrl: 'http://127.0.0.1:1234',
  model: 'qwen',
  systemPrompt: '',
  mcpTools: '',
  contextLength: '',
  reasoning: '',
  stallSeconds: '180',
  historyChars: '24000',
  hasToken: false,
}

interface Overrides {
  open?: boolean
  config?: Partial<PublicConfig> | null
  modelConfig?: ModelConfig | null
  onSave?: Mock
  onClose?: Mock
}

function setup(overrides: Overrides = {}) {
  const props = {
    open: true,
    modelConfig: null,
    onSave: vi.fn(() => Promise.resolve()),
    onClose: vi.fn(),
    ...overrides,
    config: overrides.config === null ? null : { ...base, ...overrides.config },
  }
  render(<SettingsSheet {...props} />)
  return props
}

const tokenField = () => screen.getByLabelText(/API token/i)

describe('token handling', () => {
  it('never shows a stored token, only that one exists', async () => {
    setup({ config: { hasToken: true } })
    await waitFor(() => expect(tokenField()).toBeInTheDocument())
    // The server never sends it, so the field starts empty.
    expect(tokenField()).toHaveValue('')
    expect(tokenField()).toHaveAttribute('placeholder', expect.stringMatching(/saved/i))
  })

  it('prompts for a token when none is set', async () => {
    setup({ config: { hasToken: false } })
    await waitFor(() => {
      expect(tokenField()).toHaveAttribute('placeholder', expect.stringMatching(/required/i))
    })
  })

  it('masks the token until revealed', async () => {
    const user = userEvent.setup()
    setup()
    await user.type(tokenField(), 'sk-lm-ABC')
    expect(tokenField()).toHaveClass('masked')
    await user.click(screen.getByRole('button', { name: /show/i }))
    expect(tokenField()).not.toHaveClass('masked')
  })

  it('counts characters and case so corruption is visible', async () => {
    const user = userEvent.setup()
    setup()
    await user.type(tokenField(), 'sk-lm-AbC')
    expect(await screen.findByText(/9 chars/)).toBeInTheDocument()
    expect(screen.getByText(/2 uppercase/)).toBeInTheDocument()
  })

  it('warns when only the part before the colon lost its capitals', async () => {
    const user = userEvent.setup()
    setup()
    await user.type(tokenField(), 'sk-lm-abcdwxyz:ExampleNotRealToken0')
    expect(await screen.findByText(/before the colon/)).toBeInTheDocument()
  })

  it('does not warn on a correctly-cased token', async () => {
    const user = userEvent.setup()
    setup()
    await user.type(tokenField(), 'sk-lm-abcDWXYZ:ExampleNotRealToken0')
    await screen.findByText(/35 chars/)
    expect(screen.queryByText(/before the colon/)).not.toBeInTheDocument()
  })

  it('only sends a token when one was typed', async () => {
    const user = userEvent.setup()
    const props = setup({ config: { hasToken: true } })
    await waitFor(() => expect(tokenField()).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(props.onSave).toHaveBeenCalled())
    // No token typed: the stored one must be left alone, not cleared.
    expect(props.onSave.mock.calls.at(-1)![0]).not.toHaveProperty('apiToken')
  })

  it('sends a newly typed token', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.type(tokenField(), 'sk-lm-NEW')
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      expect(props.onSave.mock.calls.at(-1)![0].apiToken).toBe('sk-lm-NEW')
    })
  })
})

describe('settings', () => {
  it('exposes the history budget, and explains replay', async () => {
    setup({ config: { historyChars: '50000' } })
    await waitFor(() => {
      expect(screen.getByLabelText(/conversation replayed/i)).toHaveValue('50000')
    })
    expect(screen.getByText(/never make the model forget/i)).toBeInTheDocument()
  })

  it('loads the server config into the form', async () => {
    setup({ config: { systemPrompt: 'be terse', mcpTools: 'mcp/astrology', stallSeconds: '90' } })
    await waitFor(() => expect(screen.getByLabelText(/system prompt/i)).toHaveValue('be terse'))
    expect(screen.getByLabelText(/Plugin IDs/i)).toHaveValue('mcp/astrology')
    expect(screen.getByLabelText(/give up after/i)).toHaveValue('90')
  })

  it('describes the address as the server-to-LM-Studio hop', async () => {
    setup()
    expect(await screen.findByText(/this app's server/i)).toBeInTheDocument()
  })

  it('saves and closes', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(props.onSave).toHaveBeenCalled())
    expect(props.onClose).toHaveBeenCalled()
  })

  it('offers the levels the loaded model declares', async () => {
    setup({
      modelConfig: {
        found: true,
        reasoning: { default: 'xhigh', options: [{ value: 'xhigh', label: 'Extra High' }] },
        thinking: { default: true },
      },
    })
    const select = await screen.findByLabelText(/default reasoning effort/i) as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'xhigh'])
  })
})

describe('typing into every field', () => {
  const fields: [RegExp, string][] = [
    [/LM Studio address/i, 'http://10.0.0.5:1234'],
    [/API token/i, 'sk-lm-ABC'],
    [/system prompt/i, 'be terse'],
    [/Plugin IDs/i, 'mcp/astrology-v2'],
    [/give up after/i, '90'],
    [/conversation replayed/i, '0'],
    [/context length/i, '8000'],
  ]

  it.each(fields)('accepts typing into %s', async (label, text) => {
    const user = userEvent.setup()
    setup()
    const field = await screen.findByLabelText(label)
    await user.clear(field)
    await user.type(field, text)
    expect(field).toHaveValue(text)
  })
})

describe('layout', () => {
  it('keeps the actions out of the scrolling region', () => {
    // Save used to be the last element inside the scroll container, so with
    // nine fields above it you had to scroll to reach it -- and the scroll
    // itself fought Vaul's drag-to-dismiss.
    const { container } = render(<SettingsSheet {...{
      open: true, config: base, modelConfig: null,
      onSave: vi.fn(() => Promise.resolve()), onClose: vi.fn(),
    }} />)
    void container
    const save = screen.getByRole('button', { name: /^save$/i })
    const scroll = document.querySelector('.drawer-scroll')
    expect(scroll).toBeInTheDocument()
    expect(scroll!.contains(save)).toBe(false)
    expect(save.closest('.drawer-actions')).not.toBeNull()
  })

  it('marks the scrolling region so a swipe there does not drag the sheet', () => {
    setup()
    const scroll = document.querySelector('.drawer-scroll')!
    expect(scroll.hasAttribute('data-vaul-no-drag')).toBe(true)
  })

  it('brings a focused field into view, clear of the footer', async () => {
    // The MCP field is last, directly above the pinned actions, so focusing
    // it used to leave it behind the footer and the software keyboard.
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    setup()
    await user.click(await screen.findByLabelText(/Plugin IDs/i))
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ block: 'center' }),
    )
  })

  it('puts the fields in the scrolling region', () => {
    setup()
    const scroll = document.querySelector('.drawer-scroll')!
    expect(scroll.contains(screen.getByLabelText(/system prompt/i))).toBe(true)
  })
})

describe('connection test', () => {
  it('asks the server to reach LM Studio and lists models', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: true, models: ['qwen', 'gemma'], error: null }),
    })))
    setup()
    await user.click(screen.getByRole('button', { name: /test connection/i }))
    expect(await screen.findByText(/2 model\(s\) available/)).toBeInTheDocument()
  })

  it('surfaces the server-reported error verbatim', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ ok: false, models: [], error: 'Invalid LM Studio API token' }),
    })))
    setup()
    await user.click(screen.getByRole('button', { name: /test connection/i }))
    expect(await screen.findByText(/Invalid LM Studio API token/)).toBeInTheDocument()
  })
})
