/** A launch younger than this reloads straight into a newer build; an older one keeps going and reloads when it is next brought back on screen. */
const JUST_OPENED_MS = 20_000

/** The build a page was made from: the hashed name of its script. */
const buildOf = (html: string): string | null => /\/assets\/(index-[\w-]+)\.js/.exec(html)?.[1] ?? null

/**
 * Whether the server is on a newer build than this page. The page came from
 * the cache; the server's page is fetched afresh (by a path the worker does
 * not serve from the shell) and the two scripts' names compared.
 */
async function serverIsNewer(): Promise<boolean> {
  const mine = buildOf(document.documentElement.outerHTML)
  if (!mine) return false
  try {
    const res = await fetch('/index.html', { cache: 'no-store' })
    if (!res.ok) return false
    const theirs = buildOf(await res.text())
    return Boolean(theirs) && theirs !== mine
  } catch {
    return false
  }
}

/**
 * The app shell from the cache on every launch, so the page paints at once
 * whatever the network is doing; see public/sw.js. Only a built app over a
 * secure origin (the tailnet's HTTPS, or localhost) can register one: over a
 * LAN address the app still installs to the home screen, it just loads from
 * the network each time.
 */
export function registerAppShell(): void {
  if (!('serviceWorker' in navigator) || !window.isSecureContext || !import.meta.env.PROD) return
  void navigator.serviceWorker.register('/sw.js')
  const openedAt = Date.now()
  let waiting = false
  // A page that has only just opened reloads at once; one in use waits, and reloads the next time it is brought back on screen.
  const reload = (): void => { window.location.reload() }
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string } | null>) => {
    if (e.data?.type !== 'app-updated') return
    if (Date.now() - openedAt < JUST_OPENED_MS || document.visibilityState === 'hidden') reload()
    else waiting = true
  })
  document.addEventListener('visibilitychange', () => { if (waiting && document.visibilityState === 'visible') reload() })
  // The worker refreshes the shell behind a navigation, but may finish before this listener exists: ask it again now, and hear the answer.
  void navigator.serviceWorker.ready.then(async (reg) => {
    if (reg.active && await serverIsNewer()) reg.active.postMessage({ type: 'refresh' })
  })
}
