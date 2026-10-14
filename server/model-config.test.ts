import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { startPlugin, closeServer } from './test-utils.ts'
import modelConfig, { isSafeModelId, extractConfig, readModelConfig } from './model-config.ts'
import type { ModelConfig } from '../src/types.ts'

let server: Server
let base: string
let home: string

// A trimmed copy of the real qwen/qwen3.8-27b manifest.
const QWEN_YAML = `
model: qwen/qwen3.8-27b
customFields:
  - key: reasoningEffort
    displayName: Reasoning Effort
    type: select
    defaultValue: xhigh
    options:
      - value: xhigh
        label: Extra High
      - value: medium
        label: Medium
      - value: low
        label: Low
  - key: enableThinking
    displayName: Enable Thinking
    type: boolean
    defaultValue: true
`

function writeManifest(id: string, yaml: string) {
  const dir = path.join(home, 'hub', 'models', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'model.yaml'), yaml)
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-lms-'))
  writeManifest('qwen/qwen3.8-27b', QWEN_YAML)
  fs.writeFileSync(path.join(home, 'secret.txt'), 'top secret')

  ;({ server, base } = await startPlugin(modelConfig({ home })))
})

afterEach(async () => {
  await closeServer(server)
  fs.rmSync(home, { recursive: true, force: true })
})

const get = (model: string) =>
  fetch(`${base}/api/model-config?model=${encodeURIComponent(model)}`)

describe('isSafeModelId', () => {
  it('accepts normal ids', () => {
    expect(isSafeModelId('qwen/qwen3.8-27b')).toBe(true)
    expect(isSafeModelId('deepseek-coder-v2-lite-instruct-mlx')).toBe(true)
  })

  it('refuses traversal and absolute paths', () => {
    for (const bad of [
      '../../etc/passwd', 'a/../../b', '/etc/passwd', 'a/b/c',
      'a//b', '', '.hidden', 'a\\b', 'a\0b', 'x'.repeat(201),
    ]) {
      expect([bad, isSafeModelId(bad)]).toEqual([bad, false])
    }
  })
})

describe('extractConfig', () => {
  it('pulls out levels and defaults', () => {
    const c = extractConfig({ customFields: [
      { key: 'reasoningEffort', defaultValue: 'xhigh', options: [{ value: 'xhigh', label: 'Extra High' }] },
      { key: 'enableThinking', defaultValue: true },
    ] })
    expect(c.reasoning).toEqual({ default: 'xhigh', options: [{ value: 'xhigh', label: 'Extra High' }] })
    expect(c.thinking).toEqual({ default: true })
  })

  it('reports null when a model has no reasoning field', () => {
    expect(extractConfig({ customFields: [{ key: 'somethingElse' }] }).reasoning).toBeNull()
  })

  it('copes with a manifest that has no customFields at all', () => {
    expect(extractConfig({}).reasoning).toBeNull()
    expect(extractConfig(null).reasoning).toBeNull()
  })

  it('labels an option lacking a label with its value', () => {
    const c = extractConfig({ customFields: [{ key: 'reasoningEffort', options: [{ value: 'low' }] }] })
    expect(c.reasoning?.options).toEqual([{ value: 'low', label: 'low' }])
  })
})

describe('GET /api/model-config', () => {
  it('returns the levels a real manifest declares', async () => {
    const res = await get('qwen/qwen3.8-27b')
    expect(res.status).toBe(200)
    const body = await res.json() as ModelConfig
    expect(body.found).toBe(true)
    expect(body.reasoning?.default).toBe('xhigh')
    expect(body.reasoning?.options.map((o) => o.value)).toEqual(['xhigh', 'medium', 'low'])
    expect(body.thinking).toEqual({ default: true })
  })

  it('reports not-found for a model with no manifest', async () => {
    const body = await (await get('nope/missing')).json()
    expect(body).toMatchObject({ found: false, reasoning: null })
  })

  it('refuses a traversal attempt', async () => {
    const res = await get('../../../etc/passwd')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid model id/)
  })

  it('cannot be tricked into reading a file outside the models dir', async () => {
    const res = await get('../secret')
    expect(res.status).toBe(400)
    expect(await res.text()).not.toMatch(/top secret/)
  })

  it('requires a model parameter', async () => {
    expect((await fetch(`${base}/api/model-config`)).status).toBe(400)
  })

  it('rejects non-GET methods', async () => {
    expect((await fetch(`${base}/api/model-config?model=x`, { method: 'POST' })).status).toBe(405)
  })

  it('leaves other routes alone', async () => {
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404)
  })

  it('survives a corrupt manifest', async () => {
    writeManifest('broken/model', '{[not: valid: yaml')
    const body = await (await get('broken/model')).json()
    expect(body.reasoning).toBeNull()
  })
})

describe('readModelConfig', () => {
  it('handles a single-segment model id', async () => {
    writeManifest('solo-model', QWEN_YAML)
    expect((readModelConfig('solo-model', { home }) as ModelConfig).reasoning?.default).toBe('xhigh')
  })
})
