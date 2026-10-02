import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { formatIntegrations, parseIntegrations } from '../lib/integrations'
import type { Integration } from '../types.ts'

interface CatalogTool { name: string; description: string }
interface CatalogServer { id: string; name: string; tools: CatalogTool[]; error?: string }
interface Catalog { servers: CatalogServer[]; fetchedAt: number }

interface ToolPickerProps {
  open: boolean
  onClose: () => void
  /** This chat's own list (stored form), or null when it follows the folder / Settings. */
  value: string | null
  /** What it follows when it has no list of its own. */
  inherited: string
  inheritedFrom: 'folder' | 'Settings'
  onChange: (tools: string | null) => void
}

/** Per server: every tool ('all'), or the chosen names. Absent = none of that server's tools. */
type Selection = Map<string, Set<string> | 'all'>

function selectionOf(stored: string): Selection {
  const sel: Selection = new Map()
  for (const i of parseIntegrations(stored)) sel.set(i.id, i.allowed_tools?.length ? new Set(i.allowed_tools) : 'all')
  return sel
}

/** What the model would be offered, in words: "astrology-v2 (2 of 14), deep-research". */
function describe(stored: string, catalog: Catalog | null): string {
  const list = parseIntegrations(stored)
  if (!list.length) return 'no tools'
  return list.map((i) => {
    const server = catalog?.servers.find((s) => s.id === i.id)
    const short = i.id.replace(/^mcp\//, '')
    if (!i.allowed_tools?.length) return short
    return server ? `${short} (${i.allowed_tools.length} of ${server.tools.length})` : `${short} (${i.allowed_tools.length})`
  }).join(', ')
}

/**
 * Which tools this chat offers the model: every server LM Studio has, with
 * each of its tools as a checkbox. Each tool the model is shown costs about
 * 500 prompt tokens a turn, so a chat that needs two of a server's fourteen
 * tools is faster for naming them. The list comes from the servers
 * themselves (the app asks them), so it is whatever they offer today;
 * refresh after changing one.
 */
export default function ToolPicker({ open, onClose, value, inherited, inheritedFrom, onChange }: ToolPickerProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'inherit' | 'custom'>(value == null ? 'inherit' : 'custom')
  const [selection, setSelection] = useState<Selection>(() => selectionOf(value ?? inherited))

  // Start from the current state each time the sheet opens.
  useEffect(() => {
    if (!open) return
    setMode(value == null ? 'inherit' : 'custom')
    setSelection(selectionOf(value ?? inherited))
  }, [open, value, inherited])

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
  useEffect(() => { if (open && !catalog) void load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const isPicked = (server: CatalogServer, tool: string): boolean => {
    const s = selection.get(server.id)
    return s === 'all' || (s instanceof Set && s.has(tool))
  }
  const pickedCount = (server: CatalogServer): number =>
    server.tools.filter((t) => isPicked(server, t.name)).length

  const toggleTool = (server: CatalogServer, tool: string): void => {
    setSelection((prev) => {
      const next = new Map(prev)
      const current = prev.get(server.id)
      const set = current === 'all' ? new Set(server.tools.map((t) => t.name)) : new Set(current ?? [])
      if (set.has(tool)) set.delete(tool)
      else set.add(tool)
      if (set.size === 0) next.delete(server.id)
      else next.set(server.id, set.size === server.tools.length ? 'all' : set)
      return next
    })
  }
  const toggleServer = (server: CatalogServer): void => {
    setSelection((prev) => {
      const next = new Map(prev)
      if (pickedCount(server) === server.tools.length && server.tools.length) next.delete(server.id)
      else next.set(server.id, 'all')
      return next
    })
  }

  const save = (): void => {
    if (mode === 'inherit') {
      onChange(null)
    } else {
      const list: Integration[] = []
      for (const [id, s] of selection) {
        if (s === 'all') list.push({ type: 'plugin', id })
        else if (s.size) list.push({ type: 'plugin', id, allowed_tools: [...s].sort() })
      }
      // A server's "all" stays plain, so a tool the server adds later is offered too.
      onChange(formatIntegrations(list))
    }
    onClose()
  }

  // Servers in the stored list that the catalog doesn't know (not in
  // mcp.json any more, or it couldn't be asked) are still shown, so a
  // choice is never silently dropped.
  const servers: CatalogServer[] = [...(catalog?.servers ?? [])]
  for (const id of selection.keys()) {
    if (!servers.some((s) => s.id === id)) servers.push({ id, name: id.replace(/^mcp\//, ''), tools: [], error: 'not in the list LM Studio has' })
  }

  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Tools for this chat</Drawer.Title>
          <div className="drawer-scroll" data-vaul-no-drag>
            <label className="toggle-row">
              <input type="radio" name="tools-mode" checked={mode === 'inherit'} onChange={() => setMode('inherit')} />
              <span>Same as {inheritedFrom}: <span className="tool-summary">{describe(inherited, catalog)}</span></span>
            </label>
            <label className="toggle-row">
              <input type="radio" name="tools-mode" checked={mode === 'custom'} onChange={() => setMode('custom')} />
              <span>Choose for this chat</span>
            </label>

            {mode === 'custom' && (
              <div className="tool-catalog" aria-label="Tool catalog">
                {loading && !catalog && <div className="hint">Asking each server for its tools…</div>}
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
                <button type="button" className="link-btn" onClick={() => void load(true)} disabled={loading}>
                  <RefreshCw size={13} aria-hidden="true" /> {loading ? 'Asking the servers…' : 'Re-ask the servers'}
                </button>
                <div className="hint">
                  Each tool the model is shown costs about 500 prompt tokens every turn, so fewer is faster.
                  Memory is separate -- the brain button.
                </div>
              </div>
            )}
          </div>
          <div className="drawer-actions">
            <div className="row">
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="button" className="primary" onClick={save}>Save</button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
