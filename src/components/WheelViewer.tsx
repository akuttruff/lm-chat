import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Download, Minimize2, X } from 'lucide-react'
import {
  AT_REST, ZOOM_MIN, constrain, distance, midpoint, pan, toggleZoom, zoomAbout, type ZoomState,
} from '../lib/pinchZoom.ts'

interface WheelViewerProps {
  title: string
  /** The wheel itself, drawn square. */
  children: ReactNode
  onSave: () => void
  onClose: () => void
}

/** Two taps this close in time and place are a double tap. */
const DOUBLE_TAP_MS = 320
const DOUBLE_TAP_PX = 30

interface Pointer { x: number; y: number }

/**
 * A chart wheel full screen, to pinch into. Two fingers zoom about the
 * pinch and pan with it; one finger pans once zoomed; a double tap zooms
 * in on the spot, or back out; a mouse wheel zooms too. The page itself
 * is pinned to scale 1 (see index.html), so the zoom is done here.
 */
export default function WheelViewer({ title, children, onSave, onClose }: WheelViewerProps) {
  const panel = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const picture = useRef<HTMLDivElement>(null)
  const state = useRef<ZoomState>(AT_REST)
  const pointers = useRef(new Map<number, Pointer>())
  /** Where a pinch began: the state then, the gap between the fingers and their midpoint. */
  const pinch = useRef<{ state: ZoomState; gap: number; mid: Pointer } | null>(null)
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** The picture's natural top-left within the stage, and its size. */
  const geometry = () => {
    const s = stage.current
    const p = picture.current
    if (!s || !p) return null
    const sr = s.getBoundingClientRect()
    return {
      stage: { width: sr.width, height: sr.height },
      offset: { x: p.offsetLeft, y: p.offsetTop },
      side: p.offsetWidth || 1,
      origin: { x: sr.left + p.offsetLeft, y: sr.top + p.offsetTop },
    }
  }

  const apply = useCallback((next: ZoomState) => {
    const g = geometry()
    const s = g ? constrain(next, g.stage, g.side, g.offset) : next
    state.current = s
    if (picture.current) picture.current.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`
    setZoomed(s.scale > ZOOM_MIN)
  }, [])

  /** A pointer's position relative to the picture's unscaled top-left. */
  const local = (e: { clientX: number; clientY: number }): Pointer => {
    const g = geometry()
    return g ? { x: e.clientX - g.origin.x, y: e.clientY - g.origin.y } : { x: e.clientX, y: e.clientY }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, local(e))
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Pointer, Pointer]
      pinch.current = { state: state.current, gap: distance(a, b) || 1, mid: midpoint(a, b) }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    const now = local(e)
    const before = pointers.current.get(e.pointerId)!
    pointers.current.set(e.pointerId, now)
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()] as [Pointer, Pointer]
      const mid = midpoint(a, b)
      const start = pinch.current
      const scaled = zoomAbout(start.state, distance(a, b) / start.gap, start.mid.x, start.mid.y)
      apply(pan(scaled, mid.x - start.mid.x, mid.y - start.mid.y))
    } else if (pointers.current.size === 1 && state.current.scale > ZOOM_MIN) {
      apply(pan(state.current, now.x - before.x, now.y - before.y))
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasPinching = pointers.current.size >= 2
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (wasPinching || e.pointerType === 'mouse' && e.button !== 0) return
    // A tap: no movement to speak of. Two of them close together zoom.
    const at = local(e)
    const previous = lastTap.current
    lastTap.current = { at: Date.now(), ...at }
    if (previous && Date.now() - previous.at < DOUBLE_TAP_MS && distance(previous, at) < DOUBLE_TAP_PX) {
      lastTap.current = null
      apply(toggleZoom(state.current, at.x, at.y))
    }
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    pinch.current = null
  }

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const at = local(e)
    apply(zoomAbout(state.current, Math.exp(-e.deltaY * 0.002), at.x, at.y))
  }

  return createPortal(
    <div className="reader-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="reader wheel-viewer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
        <div className="reader-bar">
          <button type="button" className="icon-btn" aria-label="Close the wheel" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
          <div className="reader-title">{title}</div>
          <div className="reader-tools">
            {zoomed && (
              <button type="button" className="copy-btn" aria-label="Zoom out to fit" title="Fit" onClick={() => apply(AT_REST)}>
                <Minimize2 size={15} aria-hidden="true" />
              </button>
            )}
            <button type="button" className="copy-btn" aria-label="Save wheel as PNG" title="Save as PNG" onClick={onSave}>
              <Download size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div
          className="wheel-stage"
          ref={stage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onWheel={onWheel}
        >
          <div className="wheel-picture" ref={picture}>{children}</div>
        </div>
        <div className="wheel-hint" aria-hidden="true">Pinch to zoom · double-tap to zoom in or out</div>
      </div>
    </div>,
    document.body,
  )
}
