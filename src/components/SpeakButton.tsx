import { useSyncExternalStore } from 'react'
import { LoaderCircle, Pause, Play, Square, Volume2 } from 'lucide-react'
import { toast } from 'sonner'
import { Speaker } from '../lib/speaker.ts'

/** The one voice for the whole page: starting a reply stops any other. */
export const speaker = new Speaker(undefined, undefined, (message) => toast.error(message))

const LABELS = {
  idle: 'Read aloud',
  loading: 'Starting to read aloud — tap to stop',
  playing: 'Pause reading aloud',
  paused: 'Resume reading aloud',
} as const

/**
 * Read this reply aloud, under the reply; the same size as the retry button
 * beside your message. While it reads, the same button pauses and resumes
 * it, and a stop button beside it ends it.
 */
export default function SpeakButton({ id, text, player = speaker }: { id: string; text: string; player?: Speaker }) {
  const state = useSyncExternalStore(player.subscribe, player.getState)
  const mine = state.id === id ? state.status : 'idle'
  return (
    <>
      <button
        type="button"
        className={`speak-btn${mine !== 'idle' ? ' active' : ''}`}
        aria-label={LABELS[mine]}
        title={LABELS[mine]}
        onClick={() => player.toggle(id, text)}
      >
        {mine === 'idle' && <Volume2 size={15} aria-hidden="true" />}
        {mine === 'loading' && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
        {mine === 'playing' && <Pause size={14} fill="currentColor" aria-hidden="true" />}
        {mine === 'paused' && <Play size={14} fill="currentColor" aria-hidden="true" />}
      </button>
      {(mine === 'playing' || mine === 'paused') && (
        <button type="button" className="speak-btn" aria-label="Stop reading aloud" title="Stop reading aloud" onClick={player.stop}>
          <Square size={11} fill="currentColor" aria-hidden="true" />
        </button>
      )}
    </>
  )
}
