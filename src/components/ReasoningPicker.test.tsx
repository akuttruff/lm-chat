import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ReasoningPicker, { labelFor, levelsFor, FALLBACK_LEVELS } from './ReasoningPicker.tsx'
import type { ModelConfig } from '../types.ts'

// What the real qwen/qwen3.8-27b manifest declares.
const qwen: ModelConfig = {
  found: true,
  model: 'qwen/qwen3.8-27b',
  reasoning: {
    default: 'xhigh',
    options: [
      { value: 'xhigh', label: 'Extra High' },
      { value: 'medium', label: 'Medium' },
      { value: 'low', label: 'Low' },
    ],
  },
  thinking: { default: true },
}

function setup(overrides = {}) {
  const props = {
    open: true, value: null, defaultValue: '', config: qwen,
    onChange: vi.fn(), onClose: vi.fn(), ...overrides,
  }
  render(<ReasoningPicker {...props} />)
  return props
}

describe('levelsFor', () => {
  it('uses the model\'s own options', () => {
    expect(levelsFor(qwen).map((l) => l.value)).toEqual(['xhigh', 'medium', 'low'])
  })

  it('falls back to the generic vocabulary without a manifest', () => {
    expect(levelsFor(null)).toEqual(FALLBACK_LEVELS)
    expect(levelsFor({ found: false, reasoning: null, thinking: null })).toEqual(FALLBACK_LEVELS)
  })
})

describe('labelFor', () => {
  it('reports auto when nothing is set anywhere', () => {
    expect(labelFor(null, '')).toBe('auto')
  })
  it('falls back to the global default', () => {
    expect(labelFor(null, 'high')).toBe('high')
  })
  it('prefers the per-chat override', () => {
    expect(labelFor('low', 'high')).toBe('low')
  })
  it('treats an explicit off as a real choice, not absence', () => {
    expect(labelFor('off', 'high')).toBe('off')
  })
})

describe('ReasoningPicker', () => {
  it('offers exactly the levels the model declares', async () => {
    setup()
    expect(await screen.findByText('Extra High')).toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('Low')).toBeInTheDocument()
    // Generic levels this model does NOT accept must not be offered.
    expect(screen.queryByText('High')).not.toBeInTheDocument()
    expect(screen.queryByText('Off')).not.toBeInTheDocument()
    expect(screen.queryByText('On')).not.toBeInTheDocument()
  })

  it('names the model\'s own default', async () => {
    setup()
    expect(await screen.findByText(/The model's own default: xhigh/)).toBeInTheDocument()
    expect(screen.getByText("This model's default")).toBeInTheDocument()
  })

  it('prefers the user\'s configured default in the Auto hint', async () => {
    setup({ defaultValue: 'low' })
    expect(await screen.findByText(/Uses your default: low/)).toBeInTheDocument()
  })

  it('selects a model-specific level', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(await screen.findByRole('button', { name: /extra high/i }))
    expect(props.onChange).toHaveBeenCalledWith('xhigh')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('marks the active level', async () => {
    setup({ value: 'medium' })
    expect(await screen.findByRole('button', { name: /medium/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /extra high/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('treats Auto as active when there is no override', async () => {
    setup({ value: null })
    expect(await screen.findByRole('button', { name: /auto/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clears the override when Auto is chosen', async () => {
    const user = userEvent.setup()
    const props = setup({ value: 'xhigh' })
    await user.click(await screen.findByRole('button', { name: /auto/i }))
    expect(props.onChange).toHaveBeenCalledWith(null)
  })

  it('says so when a model has no reasoning setting', async () => {
    setup({ config: { found: true, reasoning: null, thinking: null } })
    expect(await screen.findByText(/doesn't expose a reasoning setting/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /auto/i })).not.toBeInTheDocument()
  })

  it('flags when it is guessing from the generic list', async () => {
    setup({ config: { found: false, reasoning: null, thinking: null } })
    expect(await screen.findByText(/manifest not found/i)).toBeInTheDocument()
    expect(screen.getByText('High')).toBeInTheDocument()
  })

  it('renders nothing when closed', () => {
    setup({ open: false })
    expect(screen.queryByText('Medium')).not.toBeInTheDocument()
  })
})
