import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * `GET /api/health`: one shape for every app on this Mac, so a monitor needs
 * nothing app-specific. What the process knows for certain is in `ok`,
 * `version`, `uptimeSeconds`, `busy` and `data`; what it depends on and must
 * ask after (the model server, an MCP server) is in `deps`, each `ok`, `down`
 * or `unknown`, with the reason for a `down` in `errors`.
 *
 * Dependencies are asked at most once per `depTtlMs`, however often the route
 * is read, so a monitor polling every few seconds does not poll the model.
 */

export type DepState = 'ok' | 'down' | 'unknown'

export interface Health {
  ok: boolean
  app: string
  /** The checkout's commit, so a monitor can tell what is deployed. */
  version: string
  startedAt: string
  uptimeSeconds: number
  /** What a restart would cut off, by name. */
  busy: Record<string, number>
  deps: Record<string, DepState>
  /** The database file: its size and when it last changed. */
  data: { file: string; bytes: number; lastWrite: string | null } | null
  errors: string[]
}

export interface HealthOptions {
  app: string
  dataFile: string
  busy: () => Record<string, number>
  /** Each resolves when the dependency answers and throws when it does not. */
  deps?: Record<string, () => Promise<unknown>>
  depTtlMs?: number
  depTimeoutMs?: number
}

/** The checkout's short commit, read once; 'unknown' outside a checkout or without git. */
export function versionOf(cwd = process.cwd()): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`no answer in ${ms}ms`)), ms)
  p.then((v) => { clearTimeout(t); resolve(v) }, (e: unknown) => { clearTimeout(t); reject(e) })
})

export class HealthCheck {
  private readonly startedAt = new Date()
  private readonly version: string
  private readonly ttl: number
  private readonly timeout: number
  private readonly cache = new Map<string, { at: number; state: DepState; error: string | null; pending: Promise<void> | null }>()
  private readonly options: HealthOptions

  constructor(options: HealthOptions) {
    this.options = options
    this.version = versionOf()
    this.ttl = options.depTtlMs ?? 20_000
    this.timeout = options.depTimeoutMs ?? 4000
  }

  /** The dependency's last known state, asked again once the last answer is older than the TTL. */
  private async dep(name: string, probe: () => Promise<unknown>): Promise<{ state: DepState; error: string | null }> {
    const now = Date.now()
    const known = this.cache.get(name)
    if (known && now - known.at < this.ttl) return known
    if (known?.pending) { await known.pending; return this.cache.get(name)! }
    const entry = { at: now, state: (known?.state ?? 'unknown') as DepState, error: known?.error ?? null, pending: null as Promise<void> | null }
    entry.pending = withTimeout(Promise.resolve().then(probe), this.timeout)
      .then(() => { entry.state = 'ok'; entry.error = null }, (e: unknown) => { entry.state = 'down'; entry.error = (e as Error).message || String(e) })
      .finally(() => { entry.at = Date.now(); entry.pending = null })
    this.cache.set(name, entry)
    await entry.pending
    return entry
  }

  private data(): Health['data'] {
    try {
      const st = fs.statSync(this.options.dataFile)
      return { file: path.basename(this.options.dataFile), bytes: st.size, lastWrite: st.mtime.toISOString() }
    } catch {
      return null
    }
  }

  async report(): Promise<Health> {
    const deps: Record<string, DepState> = {}
    const errors: string[] = []
    await Promise.all(Object.entries(this.options.deps ?? {}).map(async ([name, probe]) => {
      const r = await this.dep(name, probe)
      deps[name] = r.state
      if (r.error) errors.push(`${name}: ${r.error}`)
    }))
    const data = this.data()
    return {
      ok: data !== null,
      app: this.options.app,
      version: this.version,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt.getTime()) / 1000),
      busy: this.options.busy(),
      deps,
      data,
      errors,
    }
  }
}
