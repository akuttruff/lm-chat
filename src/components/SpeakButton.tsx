import { useState, useSyncExternalStore } from 'react'
import { LoaderCircle, Pause, Play, RotateCcw, RotateCw, Volume2, X } from 'lucide-react'
import { toast } from 'sonner'
import { SKIP_SECONDS, Speaker, clock, type SpeakerState } from '../lib/speaker.ts'

/** The one voice for the whole page: starting a reply stops any other. */
export const speaker = new Speaker(undefined, undefined, (message) => toast.error(message))

const LABELS = {
  idle: 'Read aloud',
  preparing: 'Preparing to read aloud — tap to stop',
  loading: 'Starting to read aloud — tap to stop',
  playing: 'Pause reading aloud',
  paused: 'Resume reading aloud',
} as const

/**
 * Read this reply aloud, under the reply; the same size as the retry button
 * beside your message. While it reads, the same button pauses and resumes
 * it, and the player below the reply (SpeechPlayer) shows where it is.
 */
export default function SpeakButton({ id, text, title, player = speaker }: { id: string; text: string; title?: string; player?: Speaker }) {
  const state = useSyncExternalStore(player.subscribe, player.getState)
  const mine = state.id === id ? state.status : 'idle'
  return (
    <button
      type="button"
      className={`speak-btn${mine !== 'idle' ? ' active' : ''}`}
      aria-label={LABELS[mine]}
      title={LABELS[mine]}
      onClick={() => player.toggle(id, text, { title })}
    >
      {mine === 'idle' && <Volume2 size={15} aria-hidden="true" />}
      {(mine === 'preparing' || mine === 'loading') && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
      {mine === 'playing' && <Pause size={14} fill="currentColor" aria-hidden="true" />}
      {mine === 'paused' && <Play size={14} fill="currentColor" aria-hidden="true" />}
    </button>
  )
}

/**
 * The track under a reply being read: play or pause, fifteen seconds either
 * way, a bar to drag through it, and the time. While the voice renders the
 * reply, the bar fills with its progress instead. Only under the reply
 * being read; nothing otherwise.
 */
export function SpeechPlayer({ id, player = speaker }: { id: string; player?: Speaker }) {
  const state = useSyncExternalStore(player.subscribe, player.getState)
  /** Where a drag has the bar, while the finger is still on it. */
  const [scrub, setScrub] = useState<number | null>(null)
  if (state.id !== id || state.status === 'idle') return null
  const busy = state.status === 'preparing' || state.status === 'loading'
  const shown = scrub ?? state.time
  const pct = state.duration > 0 ? (shown / state.duration) * 100 : 0
  return (
    <div className="speech-player" role="group" aria-label="Reading aloud">
      <button
        type="button"
        className="speech-btn speech-play"
        aria-label={LABELS[state.status]}
        title={LABELS[state.status]}
        onClick={() => (state.status === 'playing' ? player.pause() : state.status === 'paused' ? player.resume() : player.stop())}
      >
        {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
        {state.status === 'playing' && <Pause size={16} fill="currentColor" aria-hidden="true" />}
        {state.status === 'paused' && <Play size={16} fill="currentColor" aria-hidden="true" />}
      </button>
      <button type="button" className="speech-btn" aria-label={`Back ${SKIP_SECONDS} seconds`} title={`Back ${SKIP_SECONDS} seconds`} disabled={busy} onClick={() => player.skip(-SKIP_SECONDS)}>
        <RotateCcw size={15} aria-hidden="true" />
      </button>
      {state.status === 'preparing'
        ? (
          <div className="speech-progress" role="progressbar" aria-label="Preparing the voice" aria-valuemin={0} aria-valuemax={state.total || 1} aria-valuenow={state.done}>
            <i style={{ width: `${state.total ? (state.done / state.total) * 100 : 0}%` }} />
          </div>
        )
        : (
          <input
            type="range"
            className="speech-range"
            aria-label="Position in the reading"
            min={0}
            max={state.duration || 0}
            step={0.1}
            value={Math.min(shown, state.duration || 0)}
            disabled={!state.duration}
            style={{ '--pct': `${pct}%` } as React.CSSProperties}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={() => { if (scrub !== null) { player.seek(scrub); setScrub(null) } }}
            onKeyUp={() => { if (scrub !== null) { player.seek(scrub); setScrub(null) } }}
            onBlur={() => { if (scrub !== null) { player.seek(scrub); setScrub(null) } }}
          />
        )}
      <button type="button" className="speech-btn" aria-label={`Forward ${SKIP_SECONDS} seconds`} title={`Forward ${SKIP_SECONDS} seconds`} disabled={busy} onClick={() => player.skip(SKIP_SECONDS)}>
        <RotateCw size={15} aria-hidden="true" />
      </button>
      <span className="speech-time" aria-live="off">
        {state.status === 'preparing'
          ? (state.total ? `preparing ${state.done}/${state.total}` : 'preparing…')
          : `${clock(shown)} / ${clock(state.duration)}`}
      </span>
      <button type="button" className="speech-btn speech-stop" aria-label="Stop reading aloud" title="Stop reading aloud" onClick={player.stop}>
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  )
}

export type { SpeakerState }
