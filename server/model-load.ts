import type { ModelLoadState, ServerConfig } from '../src/types.ts'
import { clearCapabilityCache } from './capabilities.ts'
import { describeHttpError, lmStudioBase, lmStudioFetch } from './lm-studio.ts'

/**
 * Loads the chat model as soon as it's picked, rather than on its first
 * message. Left to LM Studio's JIT load, the first reply after a switch
 * waited out the whole load -- minutes, for a 70 GB model -- with nothing
 * else to show for it.
 */

/** Long enough for the largest model off a cold disk; a load past this is reported as failed. */
export const LOAD_TIMEOUT_MS = 10 * 60_000

interface ModelsResponse {
  models?: { key?: string; loaded_instances?: { id?: string }[] }[]
}

/** Whether LM Studio has `model` loaded: by key, or by a loaded instance's id (as capabilities.ts matches). */
async function isLoaded(config: ServerConfig, model: string): Promise<boolean> {
  const res = await lmStudioFetch(config, '/api/v1/models', { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(await describeHttpError(res))
  const data = await res.json() as ModelsResponse
  return (data.models || []).some((m) => (m.key === model || (m.loaded_instances || []).some((i) => i.id === model))
    && Boolean(m.loaded_instances?.length))
}

export class ModelLoader {
  /** One load per model at a time: a second would leave LM Studio holding two copies. */
  private inflight = new Map<string, Promise<ModelLoadState>>()
  private states = new Map<string, ModelLoadState>()
  /** The model last asked for -- the one Settings and the header show. */
  private current: string | null = null

  constructor(
    /** Told of every change to the current model's state, to broadcast it. */
    private onChange: (state: ModelLoadState) => void = () => {},
    private timeoutMs = LOAD_TIMEOUT_MS,
  ) {}

  /** The current model's state, for a client that connects mid-load. */
  state(): ModelLoadState | null {
    return this.current ? this.states.get(this.current) ?? null : null
  }

  /** The load of `model` in progress, if any, for a turn to wait on. Never rejects. */
  inFlight(model: string): Promise<ModelLoadState> | undefined {
    return this.inflight.get(model)
  }

  /** Make sure `config.model` is loaded, loading it if not. Never rejects: a failure is a state. */
  ensure(config: ServerConfig): Promise<ModelLoadState> | null {
    const model = config.model
    if (!model) return null
    this.current = model
    const running = this.inflight.get(model)
    if (running) {
      // Picked again while still loading (A, then B, then back to A): A is current again.
      this.onChange(this.states.get(model)!)
      return running
    }
    // Last time's outcome is no longer the news while this one is checked.
    this.states.delete(model)
    const load = this.load(config, model).finally(() => this.inflight.delete(model))
    this.inflight.set(model, load)
    return load
  }

  private set(state: ModelLoadState): ModelLoadState {
    this.states.set(state.model, state)
    // A model switched away from still finishes loading, but quietly: the
    // clients are showing the one picked since.
    if (state.model === this.current) this.onChange(state)
    return state
  }

  private async load(config: ServerConfig, model: string): Promise<ModelLoadState> {
    const startedAt = Date.now()
    const done = (error: string | null): ModelLoadState => {
      // What LM Studio says a model accepts can depend on the loaded instance.
      clearCapabilityCache()
      return this.set({ model, state: error ? 'failed' : 'ready', startedAt, error })
    }
    try {
      if (await isLoaded(config, model)) return done(null)
    } catch (err) {
      return done(`Couldn't ask LM Studio at ${lmStudioBase(config)} which models are loaded. (${(err as Error).message})`)
    }
    this.set({ model, state: 'loading', startedAt, error: null })
    const body: Record<string, unknown> = { model }
    // The same length a turn asks for (see requestFor): an instance loaded
    // with another would be passed over, and LM Studio would load a second.
    const ctx = Number.parseInt(config.contextLength, 10)
    if (Number.isFinite(ctx) && ctx > 0) body.context_length = ctx
    try {
      const res = await lmStudioFetch(config, '/api/v1/models/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) return done(await describeHttpError(res))
      const data = await res.json().catch(() => ({})) as { error?: { message?: string } }
      return done(data.error ? data.error.message || 'LM Studio could not load it.' : null)
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        return done(`LM Studio took more than ${Math.round(this.timeoutMs / 60_000)} minutes to load it.`)
      }
      // Node's fetch gives up waiting for headers after five minutes, while
      // LM Studio carries on loading: it may well have finished regardless.
      try { if (await isLoaded(config, model)) return done(null) } catch { /* reported below */ }
      return done(`Couldn't load it: ${(err as Error).message}`)
    }
  }
}
