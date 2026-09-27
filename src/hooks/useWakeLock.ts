import { useEffect, useRef } from 'react'

/**
 * Hold a screen wake lock while a reply is streaming.
 *
 * On a phone this is not a nicety: iOS auto-locks the screen after as little
 * as 30 seconds, and locking suspends the tab and kills the in-flight
 * connection. LM Studio then logs "Client disconnected" and abandons the
 * generation, which surfaces here as a dropped or timed-out reply.
 */
export default function useWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!active) return undefined

    let cancelled = false

    const acquire = async (): Promise<void> => {
      try {
        const lock = await navigator.wakeLock?.request('screen')
        if (cancelled) {
          await lock?.release()
          return
        }
        sentinel.current = lock ?? null
      } catch {
        // Unsupported, or refused because the page is hidden. Not fatal.
      }
    }

    void acquire()

    // iOS releases the lock whenever the tab is hidden, so take it again on
    // return rather than leaving the screen free to sleep mid-reply.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel.current?.release().catch(() => { /* already gone */ })
      sentinel.current = null
    }
  }, [active])
}
