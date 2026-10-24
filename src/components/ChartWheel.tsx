import { memo, useState } from 'react'
import { Download } from 'lucide-react'
import WheelViewer from './WheelViewer'
import { WHEEL_BACKGROUND, WheelCaption, WheelSvg } from './WheelSvg'
import { type Wheel, wheelTitle } from '../lib/chartWheel.ts'
import { downloadBlob } from '../lib/export.ts'

/** Rasterises the wheel on screen into a square PNG and offers it as a download. */
async function savePng(svg: SVGSVGElement, fileName: string): Promise<void> {
  const copy = svg.cloneNode(true) as SVGSVGElement
  const px = 1600
  copy.setAttribute('width', String(px))
  copy.setAttribute('height', String(px))
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('could not draw the wheel'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = px
    canvas.height = px
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = WHEEL_BACKGROUND
    ctx.fillRect(0, 0, px, px)
    ctx.drawImage(img, 0, 0, px, px)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (png) downloadBlob(fileName, png)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** "2026-10-13 05:58" as a file-name-safe stamp: 2026-10-13-0558. */
const stamp = (dateTime: string | null): string => (dateTime ?? '').replace(/[^0-9]+/g, '-').replace(/^-|-$/g, '') || 'chart'

/**
 * A chart wheel in a tool card (the picture is WheelSvg.tsx): a tap opens
 * it full screen to pinch and zoom (WheelViewer), and it saves as a PNG.
 */
function ChartWheel({ wheel, readings }: { wheel: Wheel; readings?: Record<string, string> }) {
  // The drawn picture, as state: a ref written from a child's callback is not allowed.
  const [svg, setSvg] = useState<SVGSVGElement | null>(null)
  const [open, setOpen] = useState(false)
  const title = wheelTitle(wheel)
  const fileName = wheel.kind === 'transit' ? `transits-${stamp(wheel.dateTime)}.png` : `chart-${stamp(wheel.dateTime)}.png`
  const save = () => { if (svg) void savePng(svg, fileName).catch(() => { /* nothing to save */ }) }

  return (
    <figure className="wheel">
      <button type="button" className="wheel-open" aria-label="Open the wheel full screen to zoom" title="Tap to zoom" onClick={() => setOpen(true)}>
        <WheelSvg wheel={wheel} title={title} onSvg={setSvg} readings={readings} />
      </button>
      {open && (
        <WheelViewer title={title} onSave={save} onClose={() => setOpen(false)}>
          <WheelSvg wheel={wheel} title={title} readings={readings} />
        </WheelViewer>
      )}
      <WheelCaption wheel={wheel} title={title}>
        <button
          type="button"
          className="copy-btn wheel-save"
          aria-label={`Save wheel as ${fileName}`}
          title={`Save as ${fileName}`}
          onClick={save}
        >
          <Download size={14} aria-hidden="true" />
        </button>
      </WheelCaption>
    </figure>
  )
}

export default memo(ChartWheel)
