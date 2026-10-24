// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
/**
 * Whether the server answers from here, judged from the requests the app
 * makes.
 *
 * A phone that opens the app before its Tailscale tunnel is up, or while the
 * Mac's address is changing, gets no answer at all rather than an error: the
 * request just hangs. So a read is given a few seconds to answer and then
 * tried again, and the app can say what is wrong (components/Unreachable.tsx)
 * instead of sitting blank.
 */

/** How long to wait on a server that gives no reply. Tests shorten these (src/test/setup.ts). */
export const REACH = {
  /** A read that has not answered by now is given up on and tried again. */
  readTimeoutMs: 8000,
  /** Before each further try of a read that got no reply. */
  retryWaitsMs: [500, 1500, 3000] as readonly number[],
  /** The server has given no reply for this long: say so on screen. */
  unreachableAfterMs: 1500,
  /** While the server is out of reach, how often to look again. */
  probeMs: 5000,
}

/** A cheap read that tells whether the server is there. */
export const PROBE_PATH = '/api/config'

type Listener = (down: boolean) => void
let down = false
const listeners = new Set<Listener>()

export const reach = {
  /** True while the last request got no answer. */
  get down(): boolean { return down },
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}

function report(next: boolean): void {
  if (next === down) return
  down = next
  for (const fn of listeners) fn(down)
}

/** A request the server never answered, as against one it answered with an error. */
export const noReply = (err: unknown): boolean =>
  err instanceof TypeError || (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError'))

export interface ReachOptions {
  /** Send once, whatever the method: for the probe, which is sent again anyway. */
  once?: boolean
}

/**
 * fetch, with care for a server out of reach. A read (GET) that has not
 * answered within REACH.readTimeoutMs is given up on and tried again after
 * each of REACH.retryWaitsMs; a write is sent once and waits as long as it
 * takes, since sending it twice could save the same thing twice. Either
 * way the outcome is reported to `reach`. A request the caller aborts is
 * neither retried nor counted against the server.
 */
export async function reachFetch(input: string, init: RequestInit = {}, options: ReachOptions = {}): Promise<Response> {
  const read = (init.method ?? 'GET').toUpperCase() === 'GET'
  const waits = read && !options.once ? REACH.retryWaitsMs : []
  const outer = init.signal ?? undefined
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController()
    const relay = () => ctl.abort(outer?.reason)
    if (outer?.aborted) relay()
    else outer?.addEventListener('abort', relay, { once: true })
    const timer = read ? setTimeout(() => ctl.abort(new DOMException('No reply', 'TimeoutError')), REACH.readTimeoutMs) : undefined
    try {
      const res = await fetch(input, { ...init, signal: ctl.signal })
      report(false)
      return res
    } catch (err) {
      if (outer?.aborted || !noReply(err)) throw err
      report(true)
      const wait = waits[attempt]
      if (wait === undefined) throw err
      await new Promise((r) => setTimeout(r, wait))
      if (outer?.aborted) throw err
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', relay)
    }
  }
}

/** Ask the server whether it is there; `reach` learns the answer either way. */
export const probe = (): Promise<void> => reachFetch(PROBE_PATH, {}, { once: true }).then(() => undefined, () => undefined)
