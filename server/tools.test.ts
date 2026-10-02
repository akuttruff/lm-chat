import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ToolCatalogCache, loadCatalog, readMcpConfig, summarize } from './tools.ts'
import type { McpServerSpec } from './tools.ts'

describe('readMcpConfig', () => {
  it("reads LM Studio's servers, leaving the memory ones to the brain button", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-mcp-'))
    const file = path.join(dir, 'mcp.json')
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {
      'astrology-v2': { command: '/usr/bin/true' },
      'deep-research': { command: 'node', args: ['x.js'], env: { A: '1' } },
      memory: { command: 'node', env: { MEMORY_DB: '/tmp/x' } },
      'lm-chat-memory': { command: 'node' },
      broken: { args: ['no command'] },
    } }))
    expect(Object.keys(readMcpConfig(file))).toEqual(['astrology-v2', 'deep-research'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is empty, not an error, when the file is missing or garbled', () => {
    expect(readMcpConfig('/nonexistent/mcp.json')).toEqual({})
  })
})

describe('summarize', () => {
  it('keeps the first sentence, on one line, within a line', () => {
    expect(summarize('Check one claim.\n\nUse it before stating a transit.')).toBe('Check one claim.')
    expect(summarize('x'.repeat(200))).toHaveLength(140)
    expect(summarize(undefined)).toBe('')
  })
})

describe('loadCatalog', () => {
  const config: Record<string, McpServerSpec> = {
    'deep-research': { command: 'node' },
    'astrology-v2': { command: 'python' },
  }

  it('asks every server, sorted by name, and reports one that fails beside the ones that answer', async () => {
    const list = vi.fn(async (spec: McpServerSpec) => {
      if (spec.command === 'python') throw new Error('no answer within 20s')
      return [{ name: 'web_search', description: 'Search the web.' }]
    })
    const catalog = await loadCatalog(config, list)
    expect(catalog.servers).toEqual([
      { id: 'mcp/astrology-v2', name: 'astrology-v2', tools: [], error: 'no answer within 20s' },
      { id: 'mcp/deep-research', name: 'deep-research', tools: [{ name: 'web_search', description: 'Search the web.' }] },
    ])
  })
})

describe('ToolCatalogCache', () => {
  it('loads once, shares a load in flight, and reloads only on refresh or expiry', async () => {
    const load = vi.fn(async () => ({ servers: [], fetchedAt: Date.now() }))
    const cache = new ToolCatalogCache(load, 60_000)
    await Promise.all([cache.get(), cache.get()])
    expect(load).toHaveBeenCalledTimes(1)
    await cache.get()
    expect(load).toHaveBeenCalledTimes(1)
    await cache.get(true)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
