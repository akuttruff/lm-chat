import { useState } from 'react'
import { Drawer } from 'vaul'
import { Check, ChevronLeft, Plus, Settings2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { labelFor, levelsFor } from './ReasoningPicker'
import ToolCatalog, { describeTools, formatSelection, selectionOf, useToolCatalog, type Selection } from './ToolCatalog'
import MemoryChecklist, { useMemories } from './MemoryChecklist'
import type { Folder, FolderUpdate, ModelConfig, PublicConfig } from '../types.ts'

interface FolderPickerProps {
  open: boolean
  onClose: () => void
  folders: Folder[]
  /** The chat being filed, and its current folder (null: none). */
  currentFolderId: string | null
  onAssign: (folderId: string | null) => void
  onCreate: (name: string) => Promise<Folder>
  onUpdate: (id: string, patch: FolderUpdate) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /** The chat model's manifest, for the reasoning levels a folder may default to. */
  modelConfig?: ModelConfig | null
  /** Settings, for what "same as Settings" currently means and which tools are known. */
  config?: PublicConfig | null
}

/** How a folder's tool list relates to Settings' -- the three states of Folder.mcpTools. */
type ToolsMode = 'inherit' | 'none' | 'custom'
const toolsModeOf = (mcpTools: string | null | undefined): ToolsMode =>
  (mcpTools == null ? 'inherit' : mcpTools === '' ? 'none' : 'custom')

/** What a folder changes for its chats, for the row under its name; '' when nothing. */
export function describeDefaults(f: Folder): string {
  const parts: string[] = []
  if (f.reasoning) parts.push(`Reasoning ${f.reasoning}`)
  if (f.mcpTools === '') parts.push('No tools')
  else if (f.mcpTools) parts.push(`Tools: ${describeTools(f.mcpTools)}`)
  if (f.memory === false) parts.push('Memory off')
  else if (f.memory === true) parts.push(f.memorySelection ? `Memory on (${f.memorySelection.length} picked)` : 'Memory on')
  else if (f.memorySelection) parts.push(`${f.memorySelection.length} ${f.memorySelection.length === 1 ? 'memory' : 'memories'} picked`)
  return parts.join(' · ')
}

/**
 * Which folder a chat is filed under. Two screens in one sheet, because they
 * are two jobs: the list files the chat (one tap), and a folder's gear opens
 * its own settings page -- name, the reasoning level and tools its chats
 * start with, and delete -- with the list out of the way. An "Astrology"
 * folder can turn thinking off and carry only the astrology tools, without
 * every chat in it being set up by hand. Deleting a folder only unfiles its
 * chats; nothing is lost.
 */
export default function FolderPicker({
  open, onClose, folders, currentFolderId, onAssign, onCreate, onUpdate, onDelete, modelConfig, config,
}: FolderPickerProps) {
  const [editing, setEditing] = useState<Folder | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    setEditing(null)
    onClose()
  }

  const assign = (folderId: string | null): void => {
    onAssign(folderId)
    close()
  }

  const create = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    try {
      const folder = await onCreate(name)
      setNewName('')
      // Made specifically to file this chat into -- do that in the same step.
      assign(folder.id)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && close()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          {editing ? (
            <FolderEditor
              key={editing.id}
              folder={editing}
              modelConfig={modelConfig}
              config={config}
              onBack={() => setEditing(null)}
              onSave={async (patch) => { await onUpdate(editing.id, patch); setEditing(null) }}
              onDelete={async () => { await onDelete(editing.id); setEditing(null) }}
            />
          ) : (
            <>
              <Drawer.Title className="drawer-title">Move to folder</Drawer.Title>
              <div className="folder-list drawer-scroll" data-vaul-no-drag>
                <button type="button" className="folder-row" onClick={() => assign(null)}>
                  <span className="folder-name">No folder</span>
                  {currentFolderId == null && <Check size={16} aria-hidden="true" />}
                </button>

                {folders.map((f) => {
                  const sub = describeDefaults(f)
                  return (
                    <div key={f.id} className="folder-row-wrap">
                      <button type="button" className="folder-row" onClick={() => assign(f.id)}>
                        <span className="folder-name">
                          {f.name}
                          {sub && <span className="folder-sub">{sub}</span>}
                        </span>
                        {currentFolderId === f.id && <Check size={16} aria-hidden="true" />}
                      </button>
                      <div className="folder-actions">
                        <button
                          type="button"
                          aria-label={`Edit ${f.name}`}
                          title="Folder settings"
                          onClick={(e) => { e.stopPropagation(); setEditing(f) }}
                        >
                          <Settings2 size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="drawer-actions">
                <div className="folder-new">
                  <input
                    type="text"
                    aria-label="New folder name"
                    placeholder="New folder"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void create() }}
                    maxLength={60}
                  />
                  <button
                    type="button"
                    className="primary"
                    aria-label="Create folder"
                    disabled={busy || !newName.trim()}
                    onClick={() => void create()}
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

interface FolderEditorProps {
  folder: Folder
  modelConfig?: ModelConfig | null
  config?: PublicConfig | null
  onBack: () => void
  onSave: (patch: FolderUpdate) => Promise<void>
  onDelete: () => Promise<void>
}

/**
 * One folder's settings. Tools are picked server by server, tool by tool,
 * from the same catalog as a chat's own Tools button -- so an "Astrology"
 * folder can start its chats with two of the server's sixteen tools, not
 * all of them. Starts from Settings' list when the folder has none of its
 * own, so "only these" begins from what chats here get today.
 */
function FolderEditor({ folder, modelConfig, config, onBack, onSave, onDelete }: FolderEditorProps) {
  const [name, setName] = useState(folder.name)
  const [reasoning, setReasoning] = useState(folder.reasoning ?? '')
  const [toolsMode, setToolsMode] = useState<ToolsMode>(toolsModeOf(folder.mcpTools))
  const [selection, setSelection] = useState<Selection>(() => selectionOf(folder.mcpTools || config?.mcpTools || ''))
  // Memory: '' inherits Settings, else on/off. Its pick is an explicit id
  // list, or null for automatic; the checklist only shows while memory is on.
  const [memory, setMemory] = useState<'' | 'on' | 'off'>(folder.memory == null ? '' : folder.memory ? 'on' : 'off')
  const [memoryPick, setMemoryPick] = useState<string[] | null>(folder.memorySelection ?? null)
  const [saving, setSaving] = useState(false)
  const { catalog, loading, refresh } = useToolCatalog(toolsMode === 'custom')
  const memoryOn = memory ? memory === 'on' : config?.memoryDefault === 'on'
  const memories = useMemories(memoryOn)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave({
        name,
        reasoning: reasoning || null,
        mcpTools: toolsMode === 'inherit' ? null : toolsMode === 'none' ? '' : formatSelection(selection),
        memory: memory ? memory === 'on' : null,
        memorySelection: memoryPick,
      })
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Delete "${folder.name}"?\n\nIts chats aren't deleted -- just unfiled.`)) return
    try {
      await onDelete()
      toast('Folder deleted')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const settingsReasoning = labelFor(null, config?.reasoning)
  const settingsTools = describeTools(config?.mcpTools ?? '', catalog)

  return (
    <>
      <div className="folder-editor-head">
        <button type="button" className="folder-back" onClick={onBack} aria-label="Back to folders">
          <ChevronLeft size={18} aria-hidden="true" /> Folders
        </button>
        <Drawer.Title className="drawer-title">{folder.name}</Drawer.Title>
      </div>
      <div className="drawer-scroll" data-vaul-no-drag>
        <div className="field">
          <label htmlFor="folder-name">Folder name</label>
          <input
            id="folder-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
          />
        </div>

        <h3 className="sheet-h">Defaults for chats in this folder</h3>
        <div className="field">
          <label htmlFor="folder-reasoning">Reasoning</label>
          <select id="folder-reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value)}>
            <option value="">Same as Settings ({settingsReasoning})</option>
            {levelsFor(modelConfig).map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
          <div className="hint">A chat can still pick its own level from the gauge by the message box.</div>
        </div>

        <div className="field">
          <label htmlFor="folder-tools">Tools</label>
          <select id="folder-tools" value={toolsMode} onChange={(e) => setToolsMode(e.target.value as ToolsMode)}>
            <option value="inherit">Same as Settings ({settingsTools})</option>
            <option value="none">None</option>
            <option value="custom">Only these…</option>
          </select>
          {toolsMode === 'custom' && (
            <ToolCatalog catalog={catalog} loading={loading} onRefresh={refresh} selection={selection} onChange={setSelection} />
          )}
          <div className="hint">
            What chats here start with; any chat can pick its own tools from the Tools button by the message box.
            Each tool the model is shown costs about 500 prompt tokens every turn, so fewer is faster.
          </div>
        </div>

        <div className="field">
          <label htmlFor="folder-memory">Memory</label>
          <select id="folder-memory" value={memory} onChange={(e) => setMemory(e.target.value as '' | 'on' | 'off')}>
            <option value="">Same as Settings ({config?.memoryDefault === 'on' ? 'on' : 'off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          {memoryOn && (
            <>
              <label htmlFor="folder-memories" className="field-sub">Memories</label>
              <select
                id="folder-memories"
                value={memoryPick ? 'custom' : 'auto'}
                onChange={(e) => setMemoryPick(e.target.value === 'auto' ? null : (folder.memorySelection ?? memories.items?.map((m) => m.id) ?? []))}
              >
                <option value="auto">Automatic (every memory that fits)</option>
                <option value="custom">Only these…</option>
              </select>
              {memoryPick && <MemoryChecklist {...memories} selection={memoryPick} onChange={setMemoryPick} />}
            </>
          )}
          <div className="hint">
            Whether chats here remember you, and which saved memories they start with; the brain button on a chat still overrides it.
          </div>
        </div>

        <div className="folder-danger">
          <button type="button" className="danger-link" onClick={() => void remove()}>
            <Trash2 size={14} aria-hidden="true" /> Delete folder
          </button>
          <div className="hint">Its chats stay; they're just unfiled.</div>
        </div>
      </div>
      <div className="drawer-actions">
        <div className="row">
          <button type="button" onClick={onBack}>Cancel</button>
          <button type="button" className="primary" onClick={() => void save()} disabled={saving || !name.trim()}>
            Save
          </button>
        </div>
      </div>
    </>
  )
}
