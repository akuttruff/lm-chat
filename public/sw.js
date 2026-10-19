// LM Chat's app shell -- the page, its script and stylesheet, the manifest and
// icons -- kept in the cache so a launch on the phone paints at once, before
// the Tailscale tunnel has woken up, and still paints with no network at all.
// The API is never cached: a chat served stale would be wrong, and
// /api/events is a live stream.
//
// The page comes from the cache first and is refreshed behind it. A new
// build's files are fetched into the cache before its page replaces the old
// one, so the cached shell is always a whole build; the page then hears
// `app-updated` and reloads if it has only just opened (see lib/appShell.ts).
const APP = 'lm-chat'
const SHELL = `${APP}-shell-v2`
const BUILD = `${APP}-build-`
const EXTRAS = ['/manifest.webmanifest', '/icon.svg', '/icon.png', '/icon-180.png']

/** The hashed files a page names: its script, stylesheet and preloads. */
const assetsIn = (html) => [...new Set(html.match(/\/assets\/[^"'()\s]+/g) ?? [])]
/** One cache per build, named after its entry script, so an old build's files can go as a whole. */
const buildOf = (html) => BUILD + (html.match(/\/assets\/(index-[\w-]+)\.js/)?.[1] ?? 'unknown')
const isAsset = (url) => url.pathname.startsWith('/assets/')

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then(async (shell) => {
    const page = await fetch('/', { cache: 'no-store' })
    if (!page.ok) throw new Error(`${page.status} for /`)
    await keepBuild(shell, page)
    await Promise.all(EXTRAS.map((path) => shell.add(path).catch(() => { /* an icon is not worth failing over */ })))
  }))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && !k.startsWith(BUILD)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return
  if (isAsset(url)) event.respondWith(assetFirst(event))
  else if (req.mode === 'navigate' || url.pathname === '/') event.respondWith(shellFirst(event))
  else event.respondWith(cachedThenRefreshed(req))
})

/** A build's files never change under their names: the cached copy, else the network's, kept for next time. */
async function assetFirst(event) {
  const hit = await caches.match(event.request)
  if (hit) return hit
  const res = await fetch(event.request)
  if (res.ok) {
    const copy = res.clone()
    event.waitUntil(currentBuild().then((name) => (name ? caches.open(name).then((c) => c.put(event.request, copy)) : undefined)))
  }
  return res
}

/** The page: from the cache at once; the network's copy, if it differs, becomes the next launch's. */
async function shellFirst(event) {
  const shell = await caches.open(SHELL)
  const cached = await shell.match('/')
  if (cached) {
    event.waitUntil(refreshShell(shell, cached))
    return cached
  }
  // Nothing cached yet (a first launch, or storage was cleared): the network's page, kept from now on.
  const res = await fetch(event.request)
  if (res.ok) event.waitUntil(keepBuild(shell, res.clone()))
  return res
}

async function refreshShell(shell, cached) {
  try {
    const res = await fetch('/', { cache: 'no-store' })
    if (!res.ok) return
    const [before, after] = await Promise.all([cached.clone().text(), res.clone().text()])
    if (before === after) return
    await keepBuild(shell, res)
    for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'app-updated' })
  } catch { /* no network: the shell on hand stays */ }
}

/** The page and every file it names go in together, so the cache always holds a whole build; older builds' files go. */
async function keepBuild(shell, page) {
  const html = await page.clone().text()
  const name = buildOf(html)
  const build = await caches.open(name)
  await Promise.all(assetsIn(html).map(async (path) => {
    if (await build.match(path)) return
    const res = await fetch(path, { cache: 'no-store' })
    if (!res.ok) throw new Error(`${res.status} for ${path}`)
    await build.put(path, res)
  }))
  await shell.put('/', page)
  for (const key of await caches.keys()) if (key.startsWith(BUILD) && key !== name) await caches.delete(key)
}

async function currentBuild() {
  const cached = await (await caches.open(SHELL)).match('/')
  return cached ? buildOf(await cached.text()) : null
}

/** The manifest and icons: the cached copy now, the network's kept for next time. */
async function cachedThenRefreshed(req) {
  const shell = await caches.open(SHELL)
  const hit = await shell.match(req)
  const refresh = fetch(req).then((res) => {
    if (res.ok) void shell.put(req, res.clone())
    return res
  })
  if (!hit) return refresh
  refresh.catch(() => { /* offline: the copy on hand */ })
  return hit
}
