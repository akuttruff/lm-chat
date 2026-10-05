import { speechChunks, speechText } from './speech.ts'

/**
 * Plays one reply aloud at a time. A reply is split into pieces
 * (speechChunks); the first is short so the voice starts at once, and each
 * next piece is fetched while the current one plays.
 *
 * One <audio> element is reused for everything. iPhone Safari only lets a
 * page play sound that a tap started, and the first piece arrives after the
 * tap has finished; an element that played something during the tap stays
 * allowed, so the tap starts it on a moment of silence first.
 */

export type SpeakerState = { id: string | null; status: 'idle' | 'loading' | 'playing' }

/** A tenth of a second of silence: 44-byte WAV header, 8 kHz, 800 zero samples. */
const SILENCE = (() => {
  const samples = 800
  const bytes = new Uint8Array(44 + samples * 2)
  const v = new DataView(bytes.buffer)
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i) }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, samples * 2, true)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `data:audio/wav;base64,${btoa(bin)}`
})()

export interface SpeakOptions {
  /** Defaults to the one in Settings, which the server applies. */
  voice?: string
  speed?: string
}

export class Speaker {
  private state: SpeakerState = { id: null, status: 'idle' }
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  /** Bumped by every speak() and stop(), so a superseded run stops at its next step. */
  private run = 0
  private urls: string[] = []
  private aborter: AbortController | null = null

  constructor(
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly makeAudio: () => HTMLAudioElement = () => new Audio(),
    private readonly onError: (message: string) => void = () => {},
  ) {}

  getState = (): SpeakerState => this.state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private set(state: SpeakerState): void {
    this.state = state
    for (const fn of this.listeners) fn()
  }

  /** Stop whatever is playing or loading. */
  stop = (): void => {
    this.run++
    this.aborter?.abort()
    this.aborter = null
    if (this.audio) {
      this.audio.onended = null
      this.audio.onerror = null
      this.audio.pause()
    }
    for (const u of this.urls) URL.revokeObjectURL(u)
    this.urls = []
    if (this.state.status !== 'idle') this.set({ id: null, status: 'idle' })
  }

  /** Tap on a reply's speaker: start it, or stop it if it's the one already going. */
  toggle = (id: string, markdown: string, options: SpeakOptions = {}): void => {
    if (this.state.id === id && this.state.status !== 'idle') { this.stop(); return }
    void this.speak(id, markdown, options)
  }

  /** Read `markdown` aloud, replacing anything already going. Must be called from a tap. */
  async speak(id: string, markdown: string, options: SpeakOptions = {}): Promise<void> {
    this.stop()
    const run = this.run
    const chunks = speechChunks(speechText(markdown))
    if (!chunks.length) return
    const audio = this.audio ?? (this.audio = this.makeAudio())
    // Inside the tap: unlock the element for the pieces that come later.
    audio.src = SILENCE
    audio.play()?.catch(() => { /* jsdom, or a browser that refuses silence: the real piece will say */ })
    this.set({ id, status: 'loading' })
    const aborter = new AbortController()
    this.aborter = aborter

    const fetchPiece = async (text: string): Promise<string> => {
      const res = await this.fetchImpl('/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(options.voice ? { voice: options.voice } : {}), ...(options.speed ? { speed: options.speed } : {}) }),
        signal: aborter.signal,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error || `The voice failed (${res.status}).`)
      }
      const url = URL.createObjectURL(await res.blob())
      this.urls.push(url)
      return url
    }

    try {
      let next = fetchPiece(chunks[0]!)
      for (let i = 0; i < chunks.length; i++) {
        const url = await next
        if (run !== this.run) return
        // Ask for the following piece now, so it's ready when this one ends.
        if (i + 1 < chunks.length) next = fetchPiece(chunks[i + 1]!)
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve()
          audio.onerror = () => reject(new Error("This device couldn't play the voice."))
          audio.src = url
          audio.play().then(() => { if (run === this.run) this.set({ id, status: 'playing' }) }, reject)
        })
        if (run !== this.run) return
        URL.revokeObjectURL(url)
        this.urls = this.urls.filter((u) => u !== url)
      }
      if (run === this.run) this.stop()
    } catch (err) {
      if (run !== this.run || (err as Error).name === 'AbortError') return
      this.stop()
      this.onError((err as Error).message)
    }
  }
}
