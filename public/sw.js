// The app shell, from cache: a cold launch on the phone paints before the
// Tailscale tunnel has even woken up. The API is never cached -- a chat
// served stale would be wrong, and /api/events is a live stream.
const CACHE = 'lm-chat-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon.png', '/icon-180.png']
/** How long to give the network for the page itself before the cached copy is used. */
const PAGE_TIMEOUT_MS = 2500

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

/** Hashed build output: its name changes with every build, so a cached copy is never stale. */
const isAsset = (url) => url.pathname.startsWith('/assets/')

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return

  if (isAsset(url)) {
    // Cache first: once fetched, a build's script and stylesheet never need the network again.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) void caches.open(CACHE).then((c) => c.put(req, res.clone()))
        return res
      })),
    )
    return
  }

  if (req.mode === 'navigate' || url.pathname === '/') {
    // The page: fresh if the network answers promptly (so a new build shows
    // up), the cached one otherwise -- and always the cached one offline.
    event.respondWith(pageFirst(req))
    return
  }

  // Icons and the manifest: cached copy now, refreshed in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res.ok) void caches.open(CACHE).then((c) => c.put(req, res.clone()))
        return res
      }).catch(() => hit)
      return hit || refresh
    }),
  )
})

async function pageFirst(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match('/')
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), PAGE_TIMEOUT_MS)),
    ])
    if (res.ok) {
      void cache.put('/', res.clone())
      void pruneAssets(cache, res.clone())
    }
    return res
  } catch {
    return cached || fetch(req)
  }
}

/** Keep only the assets the current page references; older builds' files just take up space. */
async function pruneAssets(cache, pageRes) {
  try {
    const html = await pageRes.text()
    const keys = await cache.keys()
    await Promise.all(keys
      .filter((k) => isAsset(new URL(k.url)) && !html.includes(new URL(k.url).pathname))
      .map((k) => cache.delete(k)))
  } catch { /* housekeeping only */ }
}
