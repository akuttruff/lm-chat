import { useEffect, useState } from 'react'
import { Drawer } from 'vaul'
import ToolCatalog, { describeTools, formatSelection, selectionOf, useToolCatalog, type Selection } from './ToolCatalog'

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

/**
 * Which tools this chat offers the model: the servers' own tool lists as
 * checkboxes (ToolCatalog), or whatever the folder / Settings say.
 */
export default function ToolPicker({ open, onClose, value, inherited, inheritedFrom, onChange }: ToolPickerProps) {
  const { catalog, loading, refresh } = useToolCatalog(open)
  const [mode, setMode] = useState<'inherit' | 'custom'>(value == null ? 'inherit' : 'custom')
  const [selection, setSelection] = useState<Selection>(() => selectionOf(value ?? inherited))

  // Start from the current state each time the sheet opens.
  useEffect(() => {
    if (!open) return
    setMode(value == null ? 'inherit' : 'custom')
    setSelection(selectionOf(value ?? inherited))
  }, [open, value, inherited])

  const save = (): void => {
    onChange(mode === 'inherit' ? null : formatSelection(selection))
    onClose()
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
              <span>Same as {inheritedFrom}: <span className="tool-summary">{describeTools(inherited, catalog)}</span></span>
            </label>
            <label className="toggle-row">
              <input type="radio" name="tools-mode" checked={mode === 'custom'} onChange={() => setMode('custom')} />
              <span>Choose for this chat</span>
            </label>

            {mode === 'custom' && (
              <>
                <ToolCatalog catalog={catalog} loading={loading} onRefresh={refresh} selection={selection} onChange={setSelection} />
                <div className="hint">
                  Each tool the model is shown costs about 500 prompt tokens every turn, so fewer is faster.
                  Memory is separate -- the brain button.
                </div>
              </>
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
