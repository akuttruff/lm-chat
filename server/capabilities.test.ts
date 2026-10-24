import { afterEach, describe, it, expect, vi } from 'vitest'
import { NO_REASONING, clearCapabilityCache, fitReasoning, cheapestReasoning, reasoningCapability, toModelConfig, withOffOption } from './capabilities.ts'
import type { ServerConfig } from '../src/types.ts'
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

  it('sends nothing to a model that takes no reasoning setting', () => {
    for (const level of ['low', 'on', 'off']) expect(fitReasoning(level, NO_REASONING)).toBeNull()
  })
})

describe('reasoningCapability', () => {
  const config = (model: string) => ({ lmStudioUrl: 'http://lm.test', apiToken: 't', model }) as ServerConfig
  const models = {
    models: [
      { key: 'qwen3.5-122b-a10b', capabilities: { vision: true, trained_for_tool_use: true } },
      { key: 'qwen/qwen3.5-9b', capabilities: { reasoning: { allowed_options: ['off', 'on'], default: 'on' } } },
    ],
  }
  afterEach(() => { vi.unstubAllGlobals(); clearCapabilityCache() })

  it('tells a model with no reasoning setting from one LM Studio does not list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(models))))
    expect(await reasoningCapability(config('qwen3.5-122b-a10b'))).toEqual(NO_REASONING)
    expect(await reasoningCapability(config('qwen/qwen3.5-9b'))).toEqual({ allowed: ['off', 'on'], default: 'on' })
    expect(await reasoningCapability(config('not-downloaded'))).toBeNull()
  })

  it('offers no reasoning picker for such a model', () => {
    expect(toModelConfig('qwen3.5-122b-a10b', NO_REASONING).reasoning).toBeNull()
  })
})

describe('cheapestReasoning', () => {
  it('prefers off, then the lowest level offered', () => {
    expect(cheapestReasoning({ allowed: ['xhigh', 'low', 'off'], default: null })).toBe('off')
    expect(cheapestReasoning({ allowed: ['xhigh', 'low'], default: null })).toBe('low')
    expect(cheapestReasoning(null)).toBeNull()
  })
})
