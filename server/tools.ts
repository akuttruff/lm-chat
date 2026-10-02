import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { MEMORY_PLUGIN } from './memory.ts'

/**
 * What tools each MCP server offers -- the catalog the tool picker shows.
 *
 * LM Studio lets a request restrict a server to named tools
 * (`allowed_tools`) but has no endpoint that says what a server's tools
 * are. So this reads the same mcp.json LM Studio does, starts each server
 * the same way, asks it for its tool list over stdio and lets it go. A
 * server takes a second or two to answer, so the catalog is cached and
 * refreshed on request.
 */

export interface CatalogTool {
  name: string
  /** The first sentence of the server's own description, enough to tell tools apart. */
  description: string
}

export interface CatalogServer {
  /** The plugin id LM Studio knows it by: `mcp/<name from mcp.json>`. */
  id: string
  name: string
  tools: CatalogTool[]
  /** Why the list is empty, when the server couldn't be asked. */
  error?: string
}

export interface ToolCatalog {
  servers: CatalogServer[]
  fetchedAt: number
}

export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export const MCP_CONFIG_PATH = path.join(os.homedir(), '.lmstudio', 'mcp.json')

/** Servers from LM Studio's mcp.json, minus the memory ones (the brain button owns those). */
export function readMcpConfig(file = MCP_CONFIG_PATH): Record<string, McpServerSpec> {
  let parsed: { mcpServers?: Record<string, McpServerSpec> }
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof parsed
  } catch {
    return {}
  }
  const servers: Record<string, McpServerSpec> = {}
  for (const [name, spec] of Object.entries(parsed.mcpServers ?? {})) {
    if (!spec || typeof spec.command !== 'string') continue
    if (`mcp/${name}` === MEMORY_PLUGIN || name === 'memory') continue
    servers[name] = spec
  }
  return servers
}

/** A description cut to its first sentence, and to a line's worth. */
export function summarize(description: string | undefined, max = 140): string {
  const first = (description || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? ''
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first
}

/** Start one server, ask it for its tools, stop it. */
export async function listServerTools(spec: McpServerSpec, timeoutMs = 20_000): Promise<CatalogTool[]> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'lm-chat', version: '1.0.0' })
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs).unref()
  })
  try {
    await Promise.race([client.connect(transport), timer])
    const result = await Promise.race([client.listTools(), timer])
    return result.tools.map((t) => ({ name: t.name, description: summarize(t.description) }))
  } finally {
    await client.close().catch(() => { /* already gone */ })
  }
}

export type ServerLister = (spec: McpServerSpec) => Promise<CatalogTool[]>

/** Every server's tools, asked for in parallel; one failing doesn't hide the others. */
export async function loadCatalog(
  config: Record<string, McpServerSpec>,
  list: ServerLister = listServerTools,
): Promise<ToolCatalog> {
  const names = Object.keys(config).sort()
  const results = await Promise.allSettled(names.map((name) => list(config[name]!)))
  const servers = names.map((name, i): CatalogServer => {
    const r = results[i]!
    return r.status === 'fulfilled'
      ? { id: `mcp/${name}`, name, tools: r.value }
      : { id: `mcp/${name}`, name, tools: [], error: (r.reason as Error)?.message || String(r.reason) }
  })
  return { servers, fetchedAt: Date.now() }
}

/**
 * The catalog, loaded once and kept for a while: starting every server to
 * open a picker would be a few seconds each time, and tool lists change
 * about as often as the servers' code does. `refresh` forces a reload (a
 * button in the picker), and a reload in flight is shared by everyone who
 * asks meanwhile.
 */
export class ToolCatalogCache {
  private catalog: ToolCatalog | null = null
  private loading: Promise<ToolCatalog> | null = null

  constructor(
    private readonly load: () => Promise<ToolCatalog> = () => loadCatalog(readMcpConfig()),
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  get(refresh = false): Promise<ToolCatalog> {
    if (!refresh && this.catalog && Date.now() - this.catalog.fetchedAt < this.ttlMs) {
      return Promise.resolve(this.catalog)
    }
    if (!this.loading) {
      this.loading = this.load()
        .then((c) => { this.catalog = c; return c })
        .finally(() => { this.loading = null })
    }
    return this.loading
  }
}
