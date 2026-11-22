import { Drawer } from 'vaul'
import { FolderMinus, Trash2 } from 'lucide-react'
import type { Folder } from '../types.ts'

interface FolderDeleteSheetProps {
  /** The folder being deleted, and how many chats are in it; null when closed. */
  target: { folder: Folder; count: number } | null
  onKeepChats: () => void
  onDeleteChats: () => void
  onClose: () => void
}

/**
 * Deleting a folder that has chats in it: keep the chats (they move to
 * Unfiled), the first and safer choice, or delete them with it. Undo
 * follows either way, in the toast.
 */
export default function FolderDeleteSheet({ target, onKeepChats, onDeleteChats, onClose }: FolderDeleteSheetProps) {
  const n = target?.count ?? 0
  const chats = `${n} ${n === 1 ? 'chat' : 'chats'}`
  return (
    <Drawer.Root open={target !== null} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content folder-delete" aria-describedby="folder-delete-hint">
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Delete &ldquo;{target?.folder.name}&rdquo;?</Drawer.Title>
          <p id="folder-delete-hint" className="hint">It has {chats}. You can undo either choice for a few seconds afterwards.</p>
          <div className="folder-delete-choices">
            <button type="button" className="primary" autoFocus onClick={onKeepChats}>
              <FolderMinus size={16} aria-hidden="true" /> Delete folder, keep its {chats}
            </button>
            <button type="button" className="danger-btn" onClick={onDeleteChats}>
              <Trash2 size={16} aria-hidden="true" /> Delete folder and its {chats}
            </button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
