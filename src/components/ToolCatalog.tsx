import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { formatIntegrations, parseIntegrations } from '../lib/integrations'
import type { Integration } from '../types.ts'

export interface CatalogTool { name: string; description: string }
export interface CatalogServer { id: string; name: string; tools: CatalogTool[]; error?: string }
export interface Catalog { servers: CatalogServer[]; fetchedAt: number }

/** Per server: every tool ('all'), or the chosen names. Absent = none of that server's tools. */
export type Selection = Map<string, Set<string> | 'all'>

export function selectionOf(stored: string): Selection {
  const sel: Selection = new Map()
  for (const i of parseIntegrations(stored)) sel.set(i.id, i.allowed_tools?.length ? new Set(i.allowed_tools) : 'all')
  return sel
}

/** The stored form of a selection. A server's "all" stays plain, so a tool it adds later is offered too. */
export function formatSelection(selection: Selection): string {
  const list: Integration[] = []
  for (const [id, s] of selection) {
    if (s === 'all') list.push({ type: 'plugin', id })
    else if (s.size) list.push({ type: 'plugin', id, allowed_tools: [...s].sort() })
  }
  return formatIntegrations(list)
}

/** What the model would be offered, in words: "astrology-v2 (2 of 14), deep-research". */
export function describeTools(stored: string, catalog: Catalog | null = null): string {
  const list = parseIntegrations(stored)
  if (!list.length) return 'no tools'
  return list.map((i) => {
    const server = catalog?.servers.find((s) => s.id === i.id)
    const short = i.id.replace(/^mcp\//, '')
    if (!i.allowed_tools?.length) return short
    return server ? `${short} (${i.allowed_tools.length} of ${server.tools.length})` : `${short} (${i.allowed_tools.length})`
  }).join(', ')
}

/** The servers' tool lists, asked for once the picker is in view; `refresh` re-asks them. */
export function useToolCatalog(active: boolean): { catalog: Catalog | null; loading: boolean; refresh: () => void } {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)

  const load = async (refresh = false): Promise<void> => {
    setLoading(true)
    try {
      const r = await fetch(`/api/tools${refresh ? '?refresh=1' : ''}`)
      const body = await r.json() as Catalog & { error?: string }
      if (!r.ok) throw new Error(body.error ?? 'Could not list tools')
      setCatalog(body)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { if (active && !catalog) void load() }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  return { catalog, loading, refresh: () => void load(true) }
}

interface ToolCatalogProps {
  catalog: Catalog | null
  loading: boolean
  onRefresh: () => void
  selection: Selection
  onChange: (next: Selection) => void
}

/**
 * Every server LM Studio has, with each of its tools as a checkbox, for the
 * per-chat tool picker and a folder's defaults alike. Each tool the model is
 * shown costs about 500 prompt tokens a turn, so a chat that needs two of a
 * server's fourteen tools is faster for naming them. The list comes from the
 * servers themselves (the app asks them), so it is whatever they offer
 * today; refresh after changing one.
 */
export default function ToolCatalog({ catalog, loading, onRefresh, selection, onChange }: ToolCatalogProps) {
  const isPicked = (server: CatalogServer, tool: string): boolean => {
    const s = selection.get(server.id)
    return s === 'all' || (s instanceof Set && s.has(tool))
  }
  const pickedCount = (server: CatalogServer): number =>
    server.tools.filter((t) => isPicked(server, t.name)).length

  const toggleTool = (server: CatalogServer, tool: string): void => {
    const next = new Map(selection)
    const current = selection.get(server.id)
    const set = current === 'all' ? new Set(server.tools.map((t) => t.name)) : new Set(current ?? [])
    if (set.has(tool)) set.delete(tool)
    else set.add(tool)
    if (set.size === 0) next.delete(server.id)
    else next.set(server.id, set.size === server.tools.length ? 'all' : set)
    onChange(next)
  }
  const toggleServer = (server: CatalogServer): void => {
    const next = new Map(selection)
    if (pickedCount(server) === server.tools.length && server.tools.length) next.delete(server.id)
    else next.set(server.id, 'all')
    onChange(next)
  }

  // Servers in the stored list that the catalog doesn't know (not in
  // mcp.json any more, or it couldn't be asked) are still shown, so a
  // choice is never silently dropped.
  const servers: CatalogServer[] = [...(catalog?.servers ?? [])]
  for (const id of selection.keys()) {
    if (!servers.some((s) => s.id === id)) servers.push({ id, name: id.replace(/^mcp\//, ''), tools: [], error: 'not in the list LM Studio has' })
  }

  return (
    <div className="tool-catalog" aria-label="Tool catalog">
      {loading && !catalog && <div className="hint">Asking each server for its tools…</div>}
      {servers.length > 0 && (
        <div className="pick-all">
          <button type="button" className="link" onClick={() => onChange(new Map(servers.map((s) => [s.id, 'all' as const])))}>
            Select all
          </button>
          <button type="button" className="link" onClick={() => onChange(new Map())}>Deselect all</button>
        </div>
      )}
      {servers.map((server) => {
        const picked = pickedCount(server)
        const all = server.tools.length > 0 && picked === server.tools.length
        return (
          <section key={server.id} className="tool-server" aria-label={server.name}>
            <label className="toggle-row tool-server-head">
              <input
                type="checkbox"
                checked={all || (server.tools.length === 0 && selection.get(server.id) === 'all')}
                ref={(el) => { if (el) el.indeterminate = picked > 0 && !all }}
                onChange={() => toggleServer(server)}
              />
              <span className="tool-server-name">{server.name}</span>
              <span className="tool-server-count">
                {server.tools.length ? `${picked} of ${server.tools.length}` : (server.error ?? 'no tools')}
              </span>
            </label>
            {server.tools.map((t) => (
              <label key={t.name} className="toggle-row tool-row">
                <input type="checkbox" checked={isPicked(server, t.name)} onChange={() => toggleTool(server, t.name)} />
                <span>
                  <span className="tool-name">{t.name}</span>
                  {t.description && <span className="tool-desc">{t.description}</span>}
                </span>
              </label>
            ))}
          </section>
        )
      })}
      <button type="button" className="link-btn" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={13} aria-hidden="true" /> {loading ? 'Asking the servers…' : 'Re-ask the servers'}
      </button>
    </div>
  )
}
