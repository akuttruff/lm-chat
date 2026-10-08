import { useEffect } from 'react'

/**
 * Keeps two CSS variables on <html> in step with the visual viewport -- the
 * part of the page actually on screen: `--app-height` and `--app-top`. On
 * iOS the layout viewport can be taller than what is visible (a hidden
 * toolbar, the home-screen app's chrome, the keyboard), and sizing the app
 * from it leaves a dead strip; the visual viewport never does. With the
 * keyboard up, the app shrinks to the space above it instead of sliding.
 */
export function viewportMetrics(w: Window = window): { height: number; top: number } {
  const vv = w.visualViewport
  if (!vv) return { height: w.innerHeight, top: 0 }
  return { height: Math.round(vv.height), top: Math.round(vv.offsetTop) }
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
