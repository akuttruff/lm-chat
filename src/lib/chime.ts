/**
 * A short chime for "your answer is ready": two quick rising notes when
 * something finished, two falling ones when it failed. Made with Web Audio,
 * so there is no sound file to ship or cache.
 *
 * iPhone Safari only lets a page make sound that a tap started, and the
 * chime comes long after the tap that asked for it. So every tap resumes the
 * shared audio context (and the first one plays a moment of silence on it),
 * which keeps it allowed to play later. iOS can suspend it again when the app
 * is backgrounded; the next tap brings it back.
 *
 * Web Audio follows the phone's silent switch, so a muted phone stays quiet.
 */

export type ChimeTone = 'done' | 'failed'

let ctx: AudioContext | null = null

function context(): AudioContext | null {
  if (ctx) return ctx
  const AC = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try { ctx = new AC() } catch { return null }
  return ctx
}

let unlocked = false

/** Call once at startup: taps from then on keep the chime allowed to play. */
export function listenForChimeUnlock(): void {
  const wake = (): void => {
    const c = context()
    if (!c) return
    if (c.state !== 'running') void c.resume().catch(() => { /* not this tap */ })
    if (!unlocked) {
      unlocked = true
      try {
        const src = c.createBufferSource()
        src.buffer = c.createBuffer(1, 1, 22050)
        src.connect(c.destination)
        src.start(0)
      } catch { /* the resume alone is enough on most browsers */ }
    }
  }
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
    window.addEventListener(type, wake, { capture: true, passive: true })
  }
}

const NOTES: Record<ChimeTone, number[]> = {
  done: [659.25, 987.77], // E5 then B5
  failed: [523.25, 392], // C5 then G4
}

function play(c: AudioContext, tone: ChimeTone): void {
  const t0 = c.currentTime + 0.02
  NOTES[tone].forEach((freq, i) => {
    const start = t0 + i * 0.13
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(0.3, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5)
    osc.connect(gain).connect(c.destination)
    osc.start(start)
    osc.stop(start + 0.55)
  })
}

/** Play the chime, if this browser allows sound right now; otherwise stay quiet. */
export function chime(tone: ChimeTone = 'done'): void {
  const c = context()
  if (!c) return
  try {
    if (c.state === 'running') play(c, tone)
    else void c.resume().then(() => { if (c.state === 'running') play(c, tone) }).catch(() => { /* not allowed yet */ })
  } catch { /* sound is a nicety, never an error */ }
}
