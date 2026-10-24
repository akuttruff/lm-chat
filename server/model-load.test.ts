import { beforeEach, describe, it, expect, vi } from 'vitest'
import { ModelLoader } from './model-load.ts'
import type { ModelLoadState, ServerConfig } from '../src/types.ts'

/** Only what a load reads of the config. */
const config = (patch: Partial<ServerConfig> = {}): ServerConfig =>
  ({ lmStudioUrl: 'http://lm.test', apiToken: 'sk-lm-TOKEN', model: 'qwen', contextLength: '', ...patch }) as ServerConfig

const reply = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

/** A stand-in LM Studio: `loaded` lists what /api/v1/models reports loaded; a load waits for `finish`. */
function lmStudio(loaded: string[] = [], { loadAnswer = () => reply({ status: 'loaded' }) } = {}) {
  let finish: () => void = () => {}
  const gate = new Promise<void>((r) => { finish = r })
  const f = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/v1/models')) {
      return reply({ models: ['qwen', 'gemma'].map((key) => ({ key, loaded_instances: loaded.includes(key) ? [{ id: key }] : [] })) })
    }
    if (url.endsWith('/api/v1/models/load') && init?.method === 'POST') return gate.then(loadAnswer)
    return reply({}, 404)
  })
  vi.stubGlobal('fetch', f)
  const loads = () => f.mock.calls.filter(([url]) => String(url).endsWith('/load'))
  return { f, finish, loads }
}

let seen: ModelLoadState[]
let loader: ModelLoader

beforeEach(() => {
  vi.unstubAllGlobals()
  seen = []
  loader = new ModelLoader((s) => seen.push(s))
})

describe('loading the chat model when it is picked', () => {
  it('leaves an already-loaded model alone, so LM Studio is not made to load a second copy', async () => {
    const { finish, loads } = lmStudio(['qwen'])
    finish()
    const state = await loader.ensure(config())
    expect(state).toMatchObject({ model: 'qwen', state: 'ready', error: null })
    expect(loads()).toHaveLength(0)
    expect(seen.map((s) => s.state)).toEqual(['ready'])
  })

  it('loads an unloaded model once, even when asked twice while it loads', async () => {
    const { finish, loads } = lmStudio()
    const first = loader.ensure(config())
    const second = loader.ensure(config())
    expect(second).toBe(first)
    await vi.waitFor(() => expect(loader.state()?.state).toBe('loading'))
    expect(loader.inFlight('qwen')).toBe(first)
    finish()
    expect(await first).toMatchObject({ state: 'ready' })
    expect(loads()).toHaveLength(1)
    const [, init] = loads()[0]!
    expect(JSON.parse(String(init!.body))).toEqual({ model: 'qwen' })
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-lm-TOKEN')
    expect(loader.inFlight('qwen')).toBeUndefined()
  })

  it('loads at the context length a turn will ask for, and only when one is set', async () => {
    const { finish, loads } = lmStudio()
    finish()
    await loader.ensure(config({ contextLength: '32768' }))
    await loader.ensure(config({ model: 'gemma', contextLength: 'lots' }))
    expect(loads().map(([, init]) => JSON.parse(String(init!.body)))).toEqual([
      { model: 'qwen', context_length: 32768 },
      { model: 'gemma' },
    ])
  })

  it("reports LM Studio's reason when the load fails", async () => {
    const { finish } = lmStudio([], {
      loadAnswer: () => reply({ error: { type: 'model_not_found', message: 'Model qwen not found in downloaded models' } }, 404),
    })
    finish()
    const state = await loader.ensure(config())
    expect(state).toMatchObject({ state: 'failed', error: 'Model qwen not found in downloaded models' })
    expect(seen.map((s) => s.state)).toEqual(['loading', 'failed'])
    expect(loader.state()).toBe(state)
  })

  it("fails without loading anything when LM Studio can't be asked what is loaded", async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    const state = await loader.ensure(config())
    expect(state).toMatchObject({ state: 'failed' })
    expect(state!.error).toMatch(/ECONNREFUSED/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps quiet about a model switched away from while it loaded', async () => {
    const { finish } = lmStudio()
    const qwen = loader.ensure(config())
    await vi.waitFor(() => expect(loader.state()?.state).toBe('loading'))
    const gemma = loader.ensure(config({ model: 'gemma' }))
    finish()
    await Promise.all([qwen, gemma])
    expect(loader.state()).toMatchObject({ model: 'gemma', state: 'ready' })
    expect(seen.filter((s) => s.model === 'qwen').map((s) => s.state)).toEqual(['loading'])
  })

  it('does nothing with no model chosen', () => {
    expect(loader.ensure(config({ model: '' }))).toBeNull()
  })
})
