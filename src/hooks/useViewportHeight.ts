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
    // Temporary diagnostic: tell the server what this device measures.
    const report = (): void => {
      const probe = document.createElement('div')
      probe.style.cssText = 'position:fixed;left:-9999px;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);height:0;width:0'
      document.body.appendChild(probe)
      const cs = getComputedStyle(probe)
      const nav = navigator as Navigator & { standalone?: boolean }
      const app = document.querySelector('.app')?.getBoundingClientRect()
      const composer = document.querySelector('.composer')?.getBoundingClientRect()
      const data = {
        vv: window.visualViewport ? { h: window.visualViewport.height, w: window.visualViewport.width, top: window.visualViewport.offsetTop, scale: window.visualViewport.scale } : null,
        inner: { h: window.innerHeight, w: window.innerWidth }, outer: { h: window.outerHeight, w: window.outerWidth },
        screen: { h: screen.height, w: screen.width, availH: screen.availHeight },
        client: { h: document.documentElement.clientHeight, bodyH: document.body.clientHeight },
        safe: { top: cs.paddingTop, bottom: cs.paddingBottom },
        standalone: nav.standalone ?? window.matchMedia?.('(display-mode: standalone)').matches ?? null,
        dpr: window.devicePixelRatio,
        app: app ? { top: app.top, h: app.height, bottom: app.bottom } : null,
        composer: composer ? { top: composer.top, bottom: composer.bottom } : null,
        vars: { height: root.style.getPropertyValue('--app-height'), top: root.style.getPropertyValue('--app-top') },
      }
      probe.remove()
      try { void fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true }).catch(() => {}) } catch { /* diagnostics only */ }
    }
    const t1 = setTimeout(report, 1500)
    const t2 = setTimeout(report, 6000)
    const vv = window.visualViewport
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      clearTimeout(t1); clearTimeout(t2)
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
      root.style.removeProperty('--app-height')
      root.style.removeProperty('--app-top')
    }
  }, [])
}
