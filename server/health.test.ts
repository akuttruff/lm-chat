import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HealthCheck, versionOf } from './health.ts'

describe('HealthCheck', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'))
  afterEach(() => { vi.useRealTimers() })

  it('reports the process, the data file and each dependency, asking a dependency once per TTL', async () => {
    const file = path.join(dir, 'app.sqlite')
    fs.writeFileSync(file, 'x'.repeat(10))
    let asked = 0
    const health = new HealthCheck({
      app: 'demo', dataFile: file, busy: () => ({ replies: 2 }), depTtlMs: 1000,
      deps: { model: async () => { asked++ }, mcp: async () => { throw new Error('refused') } },
    })
    const a = await health.report()
    expect(a).toMatchObject({ ok: true, app: 'demo', busy: { replies: 2 }, deps: { model: 'ok', mcp: 'down' }, errors: ['mcp: refused'] })
    expect(a.data).toMatchObject({ file: 'app.sqlite', bytes: 10 })
    expect(a.data?.lastWrite).toMatch(/^\d{4}-/)
    expect(a.uptimeSeconds).toBeGreaterThanOrEqual(0)
    expect(typeof a.version).toBe('string')
    await health.report()
    expect(asked).toBe(1)
  })

  it('is not ok without its data file, and a slow dependency is down', async () => {
    const health = new HealthCheck({
      app: 'demo', dataFile: path.join(dir, 'missing.sqlite'), busy: () => ({}), depTimeoutMs: 20,
      deps: { model: () => new Promise(() => { /* never answers */ }) },
    })
    const r = await health.report()
    expect(r.ok).toBe(false)
    expect(r.data).toBeNull()
    expect(r.deps.model).toBe('down')
    expect(r.errors[0]).toMatch(/no answer in 20ms/)
  })

  it('reads the checkout\'s commit, or says unknown outside one', () => {
    expect(versionOf()).toMatch(/^[0-9a-f]{7,}$/)
    expect(versionOf(os.tmpdir())).toBe('unknown')
  })
})
