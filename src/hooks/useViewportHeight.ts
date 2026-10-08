import { useEffect } from 'react'

/**
 * Keeps two CSS variables on <html> in step with what is actually on screen:
 * `--app-height` and `--app-top`. The visual viewport is the honest measure
 * on iOS (a hidden toolbar, the keyboard), with one exception measured on an
 * iPhone: as a home-screen app with a translucent status bar, every viewport
 * height comes back short by the status bar (762 on an 812-point screen)
 * even though the page is drawn edge to edge from under the status bar --
 * so that many points went missing under the composer. The window's outer
 * height is the only one that says 812, so in that mode the difference is
 * added back. With the keyboard up the app shrinks to the space above it.
 */
export function viewportMetrics(w: Window = window): { height: number; top: number } {
  const vv = w.visualViewport
  const standalone = (w.navigator as Navigator & { standalone?: boolean }).standalone === true
  const slack = standalone ? Math.max(0, w.outerHeight - w.innerHeight) : 0
  if (!vv) return { height: w.innerHeight + slack, top: 0 }
  return { height: Math.round(vv.height + slack), top: Math.round(vv.offsetTop) }
}

export default function useViewportHeight(): void {
  useEffect(() => {
    const root = document.documentElement
    const apply = (): void => {
      const { height, top } = viewportMetrics()
      root.style.setProperty('--app-height', `${height}px`)
      root.style.setProperty('--app-top', `${top}px`)
    }
    apply()
    const vv = window.visualViewport
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--app-top')
    }
  }, [])
}
