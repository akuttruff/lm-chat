import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Keeps `--header-h` and `--composer-h` on the given element equal to the
 * rendered heights of its header and composer, so the CSS that slides them
 * out of view (see .chrome-hidden) can pull the thread up by exactly that
 * much, whatever the title or the message box's current size.
 */
export default function useChromeHeights(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
    if (!root || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const name = el.classList.contains('app-header') ? '--header-h' : '--composer-h'
        root.style.setProperty(name, `${Math.round(el.getBoundingClientRect().height)}px`)
      }
    })
    const watch = (): void => {
      observer.disconnect()
      for (const sel of ['.app-header', '.composer']) {
        const el = root.querySelector<HTMLElement>(sel)
        if (el) observer.observe(el)
      }
    }
    watch()
    // The composer comes and goes (collapsed on a wide screen): re-attach when children change.
    const children = new MutationObserver(watch)
    children.observe(root, { childList: true })
    return () => { observer.disconnect(); children.disconnect() }
  }, [ref])
}
