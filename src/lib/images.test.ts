import { describe, it, expect } from 'vitest'
import { hasImage, imageFiles, prepareImage } from './images.ts'

const file = (name: string, type: string, bytes: number[] = [1, 2, 3]): File =>
  new File([new Uint8Array(bytes)], name, { type })

describe('prepareImage', () => {
  it('sends a file as it is where there is no canvas to scale it (as in this test runner)', async () => {
    const out = await prepareImage(file('cat.png', 'image/png', [0x89, 0x50]))
    expect(out).toEqual({ name: 'cat.png', mime: 'image/png', dataUrl: 'data:image/png;base64,iVA=' })
  })

  it('names a nameless file (a pasted screenshot) by its type', async () => {
    const out = await prepareImage(file('', 'image/jpeg'))
    expect(out.name).toBe('image.jpeg')
  })

  it('refuses what is not an image type the model takes', async () => {
    await expect(prepareImage(file('notes.txt', 'text/plain'))).rejects.toThrow(/not a PNG, JPEG, WebP or GIF/)
    await expect(prepareImage(file('a.svg', 'image/svg+xml'))).rejects.toThrow(/not a PNG/)
  })
})

describe('hasImage', () => {
  it('spots an image in a drag by kind and type, with no file to read yet', () => {
    const items = (list: { kind: string; type: string }[]) =>
      list.map((i) => ({ ...i, getAsFile: () => null })) as unknown as DataTransferItemList
    expect(hasImage(items([{ kind: 'file', type: 'image/png' }]))).toBe(true)
    expect(hasImage(items([{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'application/pdf' }]))).toBe(false)
    expect(hasImage(undefined)).toBe(false)
  })
})

describe('imageFiles', () => {
  it('keeps the image files among pasted or dropped items, in order', () => {
    const items = [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => file('a.png', 'image/png') },
      { kind: 'file', type: 'application/pdf', getAsFile: () => file('a.pdf', 'application/pdf') },
      { kind: 'file', type: 'image/webp', getAsFile: () => file('b.webp', 'image/webp') },
    ] as unknown as DataTransferItemList
    expect(imageFiles(items).map((f) => f.name)).toEqual(['a.png', 'b.webp'])
    expect(imageFiles(null)).toEqual([])
  })
})
