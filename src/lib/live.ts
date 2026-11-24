/**
 * A server's live updates (Server-Sent Events) kept open on a phone.
 *
 * The browser's EventSource retries a dropped stream by itself, but not in
 * every case, and it can't see a stream that has quietly died:
 *
 * - Safari gives up for good after some failures (the stream is CLOSED and
 *   never tried again), which left a page saying "reconnecting" until it
 *   was reloaded.
 * - A phone that sleeps, or moves between Wi-Fi and mobile data, can leave
 *   the connection dead without an error; and a retry made before the
 *   Tailscale tunnel is back up just hangs, neither opening nor failing.
 *
 * So this watches the stream itself. The server sends a `ping` event every
 * HEARTBEAT_MS (a named event, which a page can see; a `:` comment line it
 * can't). Nothing at all for STALE_MS means the connection is dead, and a
 * stream that hasn't opened within OPEN_TIMEOUT_MS is stuck: either way it
 * is closed and opened afresh, after a growing pause. Coming back on screen
 * or back online tries at once.
 *
 * What it reports is debounced: `down` only after the stream has been out
 * for DOWN_AFTER_MS, so a blip that heals in a second never shows.
 *
 * Every app with live updates on this Mac keeps a copy of this file; keep
 * them the same. The server's side is two lines: send `event: ping` on a
 * timer, and send the full state first on every new connection, so a page
 * that reconnects is whole again.
 */

export type LinkState = 'connecting' | 'live' | 'down'

/** Timings. Tests shorten these. */
export const LIVE = {
  /** How often the server sends a ping (the server's own constant must match). */
  heartbeatMs: 15_000,
  /** Nothing received for this long: the connection is dead. */
  staleMs: 40_000,
  /** A stream that hasn't opened by now is stuck. */
  openTimeoutMs: 10_000,
  /** Out of reach for this long before the page says so. */
  downAfterMs: 3_000,
  /** Pauses before each new try; the last one repeats. */
  retryMs: [1_000, 2_000, 5_000, 10_000, 15_000] as readonly number[],
  /** How often the watchdog looks. */
  checkMs: 5_000,
}

export interface LiveOptions {
  url: string
  /** Each unnamed message's data. */
  onMessage?: (data: string) => void
  /** Named events to listen for, besides `ping` (which is handled here). */
  events?: Record<string, (data: string) => void>
  /** A new connection opened: the server is about to send its full state. */
  onOpen?: () => void
  /** The link changed, debounced as above. */
  onState?: (state: LinkState) => void
}

export interface Live {
  /** Close it for good. */
  close: () => void
  /** Close and open again now (a page that knows it's stale). */
  restart: () => void
}

export function openLive(options: LiveOptions): Live {
  let source: EventSource | null = null
  let state: LinkState = 'connecting'
  let reported: LinkState | null = null
  let lastSeen = Date.now()
  let tries = 0
  let closed = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let openTimer: ReturnType<typeof setTimeout> | null = null
  let downTimer: ReturnType<typeof setTimeout> | null = null

  const report = (next: LinkState): void => {
    state = next
    if (next === 'down') {
      // Say so only once it has lasted: most drops heal in a second.
      if (reported !== 'down' && !downTimer) {
        downTimer = setTimeout(() => {
          downTimer = null
          if (state !== 'live' && !closed) { reported = 'down'; options.onState?.('down') }
        }, LIVE.downAfterMs)
      }
      return
    }
    if (downTimer) { clearTimeout(downTimer); downTimer = null }
    if (reported !== next) { reported = next; options.onState?.(next) }
  }

  const seen = (): void => {
    lastSeen = Date.now()
    if (state !== 'live') {
      tries = 0
      report('live')
    }
  }

  const clearTimers = (): void => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    if (openTimer) { clearTimeout(openTimer); openTimer = null }
  }

  const drop = (): void => {
    if (!source) return
    source.onopen = null
    source.onmessage = null
    source.onerror = null
    source.close()
    source = null
  }

  /** Close what's there and open again after the next pause (or now). */
  const retry = (now = false): void => {
    if (closed) return
    drop()
    clearTimers()
    report('down')
    const wait = now ? 0 : LIVE.retryMs[Math.min(tries, LIVE.retryMs.length - 1)]!
    tries++
    retryTimer = setTimeout(open, wait)
  }

  function open(): void {
    if (closed) return
    clearTimers()
    drop()
    const es = new EventSource(options.url)
    source = es
    es.onopen = () => {
      if (openTimer) { clearTimeout(openTimer); openTimer = null }
      seen()
      options.onOpen?.()
    }
    es.onmessage = (e: MessageEvent<string>) => {
      seen()
      options.onMessage?.(e.data)
    }
    es.addEventListener('ping', () => seen())
    for (const [name, fn] of Object.entries(options.events ?? {})) {
      es.addEventListener(name, (e) => {
        seen()
        fn((e as MessageEvent<string>).data)
      })
    }
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // The browser has given up on this one: open a new one ourselves.
        retry()
        return
      }
      // The browser is trying again; the open timer catches a try that hangs.
      // Reported as down only if it lasts (see report).
      report('down')
      if (!openTimer) openTimer = setTimeout(() => { openTimer = null; retry() }, LIVE.openTimeoutMs)
    }
    // A first try that hangs is caught the same way.
    openTimer = setTimeout(() => { openTimer = null; if (es.readyState !== EventSource.OPEN) retry() }, LIVE.openTimeoutMs)
  }

  // A connection that has gone quiet is dead, whatever it says.
  const watchdog = setInterval(() => {
    if (closed || !source) return
    if (state === 'live' && Date.now() - lastSeen > LIVE.staleMs) retry(true)
  }, LIVE.checkMs)

  // Back on screen, or back online: a stream that slept with the phone is likely dead, so don't wait for the watchdog.
  const wake = (): void => {
    if (closed) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (state !== 'live' || Date.now() - lastSeen > LIVE.heartbeatMs + 5_000) retry(true)
  }
  const offline = (): void => { if (!closed) report('down') }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake)
  if (typeof window !== 'undefined') {
    window.addEventListener('online', wake)
    window.addEventListener('pageshow', wake)
    window.addEventListener('offline', offline)
  }

  open()

  return {
    close: () => {
      closed = true
      clearTimers()
      if (downTimer) { clearTimeout(downTimer); downTimer = null }
      clearInterval(watchdog)
      drop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake)
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', wake)
        window.removeEventListener('pageshow', wake)
        window.removeEventListener('offline', offline)
      }
    },
    restart: () => retry(true),
  }
}

/** The server's half: a ping the page can see. Write it every LIVE.heartbeatMs. */
export const PING_FRAME = 'event: ping\ndata: 1\n\n'
