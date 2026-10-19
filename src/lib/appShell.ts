/** A launch younger than this reloads straight into a newer build; an older one keeps going and gets it next time. */
const JUST_OPENED_MS = 8000

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
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string } | null>) => {
    if (e.data?.type === 'app-updated' && Date.now() - openedAt < JUST_OPENED_MS) window.location.reload()
  })
}
