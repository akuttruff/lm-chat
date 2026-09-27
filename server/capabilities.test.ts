import { describe, it, expect } from 'vitest'
import { fitReasoning, cheapestReasoning, withOffOption } from './capabilities.ts'
import type { ModelConfig } from '../src/types.ts'

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

describe('withOffOption', () => {
  it('adds Off after the manifest levels when LM Studio accepts it', () => {
    const out = withOffOption(qwen, { allowed: ['off', 'low', 'medium', 'xhigh', 'on'], default: 'xhigh' })
    expect(out.reasoning!.options.map((o) => o.value)).toEqual(['xhigh', 'medium', 'low', 'off'])
    expect(out.reasoning!.default).toBe('xhigh')
  })

  it('leaves Off out when LM Studio says the model always reasons', () => {
    const out = withOffOption(qwen, { allowed: ['low', 'medium', 'xhigh'], default: 'xhigh' })
    expect(out.reasoning!.options.map((o) => o.value)).not.toContain('off')
  })

  it('falls back to the manifest thinking toggle when LM Studio is unreachable', () => {
    expect(withOffOption(qwen, null).reasoning!.options.at(-1)!.value).toBe('off')
    expect(withOffOption({ ...qwen, thinking: null }, null).reasoning!.options.map((o) => o.value))
      .not.toContain('off')
  })

  it('does not add a second Off, or one to a model without levels', () => {
    const withOff = withOffOption(qwen, { allowed: ['off'], default: null })
    expect(withOffOption(withOff, { allowed: ['off'], default: null }).reasoning!.options
      .filter((o) => o.value === 'off')).toHaveLength(1)
    const none: ModelConfig = { found: true, model: 'x', reasoning: null, thinking: null }
    expect(withOffOption(none, { allowed: ['off'], default: null })).toBe(none)
  })
})

describe('fitReasoning', () => {
  it('passes off through when the model allows it', () => {
    expect(fitReasoning('off', { allowed: ['off', 'on'], default: 'on' })).toBe('off')
  })

  it('maps a level the model lacks onto on, and drops what has no match', () => {
    expect(fitReasoning('medium', { allowed: ['off', 'on'], default: 'on' })).toBe('on')
    expect(fitReasoning('off', { allowed: ['low', 'high'], default: 'low' })).toBeNull()
  })
})

describe('cheapestReasoning', () => {
  it('prefers off, then the lowest level offered', () => {
    expect(cheapestReasoning({ allowed: ['xhigh', 'low', 'off'], default: null })).toBe('off')
    expect(cheapestReasoning({ allowed: ['xhigh', 'low'], default: null })).toBe('low')
    expect(cheapestReasoning(null)).toBeNull()
  })
})
