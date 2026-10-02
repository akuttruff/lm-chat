import { describe, it, expect } from 'vitest'
import { formatIntegrations, parseIntegrations } from './integrations'

describe('integrations', () => {
  it('qualifies bare labels and drops blanks', () => {
    expect(parseIntegrations('astrology, mcp/deep-research, , ')).toEqual([
      { type: 'plugin', id: 'mcp/astrology' },
      { type: 'plugin', id: 'mcp/deep-research' },
    ])
    expect(parseIntegrations('')).toEqual([])
  })

  it("keeps a server's chosen tools together, commas and all", () => {
    expect(parseIntegrations('mcp/astrology-v2(verify_claim, create_transit_chart), deep-research, memory()')).toEqual([
      { type: 'plugin', id: 'mcp/astrology-v2', allowed_tools: ['verify_claim', 'create_transit_chart'] },
      { type: 'plugin', id: 'mcp/deep-research' },
      { type: 'plugin', id: 'mcp/memory' }, // empty parentheses mean no restriction
    ])
  })

  it('round-trips through the stored form', () => {
    const list = parseIntegrations('mcp/astrology-v2(verify_claim, list_upcoming_transits), mcp/deep-research')
    expect(formatIntegrations(list)).toBe('mcp/astrology-v2(verify_claim, list_upcoming_transits), mcp/deep-research')
    expect(parseIntegrations(formatIntegrations(list))).toEqual(list)
    expect(formatIntegrations([])).toBe('')
  })
})
