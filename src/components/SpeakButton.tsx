import { useSyncExternalStore } from 'react'
import { LoaderCircle, Square, Volume2 } from 'lucide-react'
import { toast } from 'sonner'
import { Speaker } from '../lib/speaker.ts'

/** The one voice for the whole page: starting a reply stops any other. */
export const speaker = new Speaker(undefined, undefined, (message) => toast.error(message))

/**
 * Read this reply aloud, under the reply; the same size as the retry button
 * beside your message. Tapping it again, while it loads or plays, stops it.
 */
export default function SpeakButton({ id, text, player = speaker }: { id: string; text: string; player?: Speaker }) {
  const state = useSyncExternalStore(player.subscribe, player.getState)
  const mine = state.id === id ? state.status : 'idle'
  const label = mine === 'idle' ? 'Read aloud' : mine === 'loading' ? 'Starting to read aloud — tap to stop' : 'Stop reading aloud'
  return (
    <button
      type="button"
      className={`speak-btn${mine !== 'idle' ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={mine !== 'idle'}
      title={label}
      onClick={() => player.toggle(id, text)}
    >
      {mine === 'idle' && <Volume2 size={15} aria-hidden="true" />}
      {mine === 'loading' && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
      {mine === 'playing' && <Square size={12} fill="currentColor" aria-hidden="true" />}
    </button>
  )
}
