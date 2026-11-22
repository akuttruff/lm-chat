import { useState } from 'react'
import { Drawer } from 'vaul'
import { Check, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { Folder } from '../types.ts'

interface FolderPickerProps {
  open: boolean
  onClose: () => void
  folders: Folder[]
  /** The chat being filed, and its current folder (null: none). */
  currentFolderId: string | null
  onAssign: (folderId: string | null) => void
  onCreate: (name: string) => Promise<Folder>
}

/** What a folder changes for its chats, for the row under its name; '' when nothing. */
export function describeDefaults(f: Folder): string {
  return f.reasoning ? `Reasoning ${f.reasoning}` : ''
}

/**
 * Which folder a chat is filed under: one tap files it, and a new folder can
 * be made here and filed into in the same step. Renaming, reasoning and
 * deleting a folder live on its header in the chat list.
 */
export default function FolderPicker({ open, onClose, folders, currentFolderId, onAssign, onCreate }: FolderPickerProps) {
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const close = onClose

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
          <Drawer.Title className="drawer-title">Move to folder</Drawer.Title>
          <div className="folder-list drawer-scroll" data-vaul-no-drag>
            <button type="button" className="folder-row" onClick={() => assign(null)}>
              <span className="folder-name">No folder</span>
              {currentFolderId == null && <Check size={16} aria-hidden="true" />}
            </button>

            {folders.map((f) => {
              const sub = describeDefaults(f)
              return (
                <button key={f.id} type="button" className="folder-row" onClick={() => assign(f.id)}>
                  <span className="folder-name">
                    {f.name}
                    {sub && <span className="folder-sub">{sub}</span>}
                  </span>
                  {currentFolderId === f.id && <Check size={16} aria-hidden="true" />}
                </button>
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
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
