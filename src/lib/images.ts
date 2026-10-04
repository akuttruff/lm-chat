import type { ImageUpload } from '../types.ts'

/**
 * Longest edge an image is sent at. Vision models look at images at about
 * this size anyway; a phone photo is 3-4x larger and only costs upload
 * time and prompt tokens for it.
 */
export const MAX_EDGE = 1600
/** Over this many bytes, a PNG is re-encoded as JPEG; under it, kept exact (screenshots with text stay crisp). */
const KEEP_PNG_UNDER = 1.5 * 1024 * 1024
export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('could not read the file'))
    r.readAsDataURL(blob)
  })

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('not a readable image'))
    img.src = url
  })

/**
 * A file from the picker, the camera or the clipboard, made ready to send:
 * scaled down to MAX_EDGE if larger, as a data URL. GIFs are sent as they
 * are (a canvas would keep one frame). Where there is no canvas (tests, an
 * old browser) the file is sent as it is.
 */
export async function prepareImage(file: File): Promise<ImageUpload> {
  if (!ACCEPTED.includes(file.type)) throw new Error(`${file.name || 'that file'} is not a PNG, JPEG, WebP or GIF`)
  const name = file.name || `image.${file.type.split('/')[1]}`
  const original = await readAsDataUrl(file)
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const ctx = canvas?.getContext?.('2d')
  if (file.type === 'image/gif' || !canvas || !ctx) return { name, mime: file.type, dataUrl: original }

  const img = await loadImage(original)
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const keepPng = file.type === 'image/png' && file.size <= KEEP_PNG_UNDER
  if (scale === 1 && (keepPng || file.type === 'image/jpeg')) return { name, mime: file.type, dataUrl: original }

  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const mime = keepPng ? 'image/png' : 'image/jpeg'
  const dataUrl = canvas.toDataURL(mime, 0.88)
  return { name: keepPng ? name : name.replace(/\.[a-z0-9]+$/i, '') + '.jpg', mime, dataUrl }
}

/**
 * Whether a drag carries an image. During dragover the browser withholds
 * the files themselves (getAsFile() is null until the drop), so this goes
 * by kind and type alone -- which is what decides if the drop is allowed.
 */
export function hasImage(items: DataTransferItemList | null | undefined): boolean {
  if (!items) return false
  return Array.from(items).some((item) => item.kind === 'file' && ACCEPTED.includes(item.type))
}

/** The images among a paste or drop, in order; anything else is ignored. */
export function imageFiles(items: DataTransferItemList | null | undefined): File[] {
  const files: File[] = []
  if (!items) return files
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue
    const f = item.getAsFile()
    if (f && ACCEPTED.includes(f.type)) files.push(f)
  }
  return files
}
