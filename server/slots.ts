/**
 * How many requests the app lets LM Studio work on at once.
 *
 * A loaded model serves a fixed number of predictions in parallel (its
 * "parallel" load setting); anything beyond that waits inside LM Studio,
 * invisibly, sending nothing -- which the stall watchdog then mistakes for a
 * hung reply. Holding the overflow here instead means a waiting chat can say
 * so, the watchdog only runs once a request is really being served, and a
 * background job never takes the slot a person is waiting for.
 */
export type SlotKind = 'turn' | 'background'

interface Waiter {
  kind: SlotKind
  grant: () => void
}

export class Slots {
  private active = 0
  private queue: Waiter[] = []

  /** `limit` is read on every grant, so a Settings change applies at once. 0 means no cap. */
  constructor(private limit: () => number) {}

  get inUse(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.length
  }

  /** Whether a request of this kind would be served without waiting. */
  free(kind: SlotKind = 'turn'): boolean {
    const blocked = kind === 'turn'
      ? this.queue.some((w) => w.kind === 'turn')
      : this.queue.length > 0
    return !blocked && this.hasRoom()
  }

  /**
   * Resolves with a release function once a slot is free. Turns are served
   * first-come first-served, ahead of any background work. Aborting `signal`
   * while still queued rejects with its reason and gives up the place.
   */
  acquire(kind: SlotKind, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error)
    return new Promise((resolve, reject) => {
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        this.active--
        this.pump()
      }
      const waiter: Waiter = {
        kind,
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          this.active++
          resolve(release)
        },
      }
      const onAbort = (): void => {
        const i = this.queue.indexOf(waiter)
        if (i === -1) return
        this.queue.splice(i, 1)
        reject(signal!.reason as Error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
      this.pump()
    })
  }

  private hasRoom(): boolean {
    const limit = this.limit()
    return !(limit > 0) || this.active < limit
  }

  private pump(): void {
    while (this.queue.length && this.hasRoom()) {
      let i = this.queue.findIndex((w) => w.kind === 'turn')
      if (i === -1) i = 0
      const [next] = this.queue.splice(i, 1)
      next!.grant()
    }
  }
}

export function parallelLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : 4
}
