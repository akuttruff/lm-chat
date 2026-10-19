import { useEffect, useRef, useState } from 'react'
import { REACH, probe, reach } from '../lib/reach.ts'

interface Props {
  /** The app's name, as the message gives it. */
  app: string
  /** The server answers again: fetch what the launch could not. */
  onBack?: () => void
}

/**
 * A strip across the top while the server cannot be reached, so an app that
 * opened from its cached shell says why it is empty and what to check (on
 * the phone, nearly always Tailscale). It looks again every few seconds, and
 * the moment the app is back on screen; once the server answers the strip
 * goes and the app refetches.
 */
export default function Unreachable({ app, onBack }: Props) {
  const [down, setDown] = useState(reach.down)
  const [shown, setShown] = useState(false)
  useEffect(() => reach.subscribe((d) => {
    setDown(d)
    if (!d) setShown(false)
  }), [])

  // Shown only once the server has been out of reach for a moment: one lost
  // request is tried again on its own, and usually answered.
  useEffect(() => {
    if (!down) return undefined
    const timer = window.setTimeout(() => setShown(true), REACH.unreachableAfterMs)
    return () => window.clearTimeout(timer)
  }, [down])

  useEffect(() => {
    if (!down) return undefined
    let timer = window.setTimeout(function look() {
      void probe()
      timer = window.setTimeout(look, REACH.probeMs)
    }, REACH.probeMs)
    // Back on screen, or the phone says it has a network again: look now.
    const now = () => { if (document.visibilityState === 'visible') void probe() }
    document.addEventListener('visibilitychange', now)
    window.addEventListener('online', now)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', now)
      window.removeEventListener('online', now)
    }
  }, [down])

  const wasDown = useRef(false)
  useEffect(() => {
    if (wasDown.current && !down) onBack?.()
    wasDown.current = down
  }, [down, onBack])

  if (!shown) return null
  return (
    <div className="unreachable" role="status">
      <span>
        <strong>Can&apos;t reach {app}.</strong> The Mac isn&apos;t answering. On a phone, check that Tailscale is connected. Trying again…
      </span>
      <button type="button" onClick={() => void probe()}>Try now</button>
    </div>
  )
}
