/**
 * Plays one reply aloud at a time, as a single track.
 *
 * The server renders the whole reply into one audio file (see
 * server/speech.ts, Tracks) and this plays it in one <audio> element. One
 * file is what makes it behave like music on a phone: it plays on with the
 * screen off, the lock screen shows it with a scrubber, and seeking is the
 * browser's own. While the file is being rendered, a loop of silence keeps
 * the audio session open, so a phone locked during those seconds still
 * starts the reading when it is ready.
 *
 * iPhone Safari only lets a page play sound that a tap started, and the
 * track arrives after the tap has finished; an element that played
 * something during the tap stays allowed, so the tap starts it on that
 * silence first.
 */

export type SpeakerStatus = 'idle' | 'preparing' | 'loading' | 'playing' | 'paused'

export interface SpeakerState {
  id: string | null
  status: SpeakerStatus
  /** While preparing: pieces rendered, of how many. */
  done: number
  total: number
  /** Where the track is, in seconds, and how long it runs (0 until known). */
  time: number
  duration: number
}

export const IDLE: SpeakerState = { id: null, status: 'idle', done: 0, total: 0, time: 0, duration: 0 }

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

/** How far a skip button moves. */
export const SKIP_SECONDS = 15

/** "4:06", or "1:02:30" past an hour. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

export interface SpeakOptions {
  /** Defaults to the one in Settings, which the server applies. */
  voice?: string
  speed?: string
  /** What the lock screen calls it: the chat's name. */
  title?: string
}

interface TrackStatus {
  name: string
  ready: boolean
  done: number
  total: number
  url?: string
  seconds?: number
  error?: string
}

export class Speaker {
  private state: SpeakerState = IDLE
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  /** Bumped by every speak() and stop(), so a superseded run stops at its next step. */
  private run = 0
  private aborter: AbortController | null = null

  constructor(
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    private readonly makeAudio: () => HTMLAudioElement = () => new Audio(),
    private readonly onError: (message: string) => void = () => {},
    private readonly session: MediaSession | null = typeof navigator !== 'undefined' ? (navigator.mediaSession ?? null) : null,
    /** How often to ask after a track still being rendered. */
    private readonly pollMs = 600,
  ) {
    this.wireSession()
  }

  getState = (): SpeakerState => this.state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private set(patch: Partial<SpeakerState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
    this.tellSession()
  }

  /** Stop whatever is playing or loading. */
  stop = (): void => {
    this.run++
    this.aborter?.abort()
    this.aborter = null
    if (this.audio) {
      this.audio.onended = null
      this.audio.onerror = null
      this.audio.ontimeupdate = null
      this.audio.ondurationchange = null
      this.audio.pause()
      this.audio.loop = false
    }
    if (this.state.status !== 'idle') this.set(IDLE)
  }

  /** Hold the voice where it is; resume() carries on from the same word. */
  pause = (): void => {
    if (this.state.status !== 'playing') return
    this.audio?.pause()
    this.set({ status: 'paused' })
  }

  /** Carry on after pause(). Call it from a tap, like speak(): iPhone Safari wants one. */
  resume = (): void => {
    if (this.state.status !== 'paused') return
    this.audio?.play()?.catch(() => { /* reported by onerror */ })
    this.set({ status: 'playing' })
  }

  /** Jump to a moment in the track, in seconds. */
  seek = (seconds: number): void => {
    const audio = this.audio
    if (!audio || !this.state.duration || this.state.status === 'preparing' || this.state.status === 'idle') return
    const time = Math.min(Math.max(seconds, 0), this.state.duration)
    audio.currentTime = time
    this.set({ time })
  }

  /** Skip forward or back by `delta` seconds. */
  skip = (delta: number): void => { this.seek(this.state.time + delta) }

  /**
   * Tap on a reply's speaker: start it; on the one already going, pause it
   * or resume it. While it's still being rendered, the tap stops it.
   */
  toggle = (id: string, markdown: string, options: SpeakOptions = {}): void => {
    if (this.state.id === id) {
      if (this.state.status === 'playing') { this.pause(); return }
      if (this.state.status === 'paused') { this.resume(); return }
      this.stop()
      return
    }
    void this.speak(id, markdown, options)
  }

  /** Read `markdown` aloud, replacing anything already going. Must be called from a tap. */
  async speak(id: string, markdown: string, options: SpeakOptions = {}): Promise<void> {
    this.stop()
    const run = this.run
    if (!markdown.trim()) return
    const audio = this.audio ?? (this.audio = this.makeAudio())
    // Inside the tap: unlock the element, and keep a sound going while the
    // track is rendered, so a phone locked meanwhile keeps this page awake.
    audio.loop = true
    audio.src = SILENCE
    audio.play()?.catch(() => { /* jsdom, or a browser that refuses silence: the real track will say */ })
    this.set({ id, status: 'preparing', done: 0, total: 0, time: 0, duration: 0 })
    if (this.session) {
      try {
        this.session.metadata = new MediaMetadata({ title: options.title || 'Reply', artist: 'LM Chat' })
      } catch { /* no MediaMetadata here */ }
    }
    const aborter = new AbortController()
    this.aborter = aborter

    try {
      const body = { id, text: markdown, ...(options.voice ? { voice: options.voice } : {}), ...(options.speed ? { speed: options.speed } : {}) }
      let status: TrackStatus
      for (;;) {
        const res = await this.fetchImpl('/api/speech/tracks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: aborter.signal,
        })
        const answer = await res.json().catch(() => ({})) as Partial<TrackStatus> & { error?: string }
        if (!res.ok || answer.error) throw new Error(answer.error || `The voice failed (${res.status}).`)
        status = answer as TrackStatus
        if (run !== this.run) return
        if (status.ready && status.url) break
        this.set({ done: status.done, total: status.total })
        await new Promise<void>((r) => setTimeout(r, this.pollMs))
        if (run !== this.run) return
      }
      audio.loop = false
      audio.ontimeupdate = () => { if (run === this.run) this.set({ time: audio.currentTime }) }
      audio.ondurationchange = () => { if (run === this.run && Number.isFinite(audio.duration)) this.set({ duration: audio.duration }) }
      audio.onended = () => { if (run === this.run) this.stop() }
      audio.onerror = () => {
        if (run !== this.run) return
        this.stop()
        this.onError("This device couldn't play the voice.")
      }
      this.set({ status: 'loading', done: status.total, total: status.total, duration: status.seconds ?? 0 })
      audio.src = status.url!
      await audio.play()
      if (run === this.run) this.set({ status: 'playing' })
    } catch (err) {
      if (run !== this.run || (err as Error).name === 'AbortError') return
      this.stop()
      this.onError((err as Error).message)
    }
  }

  /** The lock screen's buttons: the same as the page's. */
  private wireSession(): void {
    const s = this.session
    if (!s) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => this.resume()],
      ['pause', () => this.pause()],
      ['stop', () => this.stop()],
      ['seekbackward', (d) => this.skip(-(d.seekOffset ?? SKIP_SECONDS))],
      ['seekforward', (d) => this.skip(d.seekOffset ?? SKIP_SECONDS)],
      ['seekto', (d) => { if (typeof d.seekTime === 'number') this.seek(d.seekTime) }],
    ]
    for (const [action, handler] of handlers) {
      try { s.setActionHandler(action, handler) } catch { /* an action this browser lacks */ }
    }
  }

  /** What the lock screen shows: playing or paused, and how far along. */
  private tellSession(): void {
    const s = this.session
    if (!s) return
    const { status, time, duration } = this.state
    try {
      s.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none'
      if (duration > 0 && (status === 'playing' || status === 'paused')) {
        s.setPositionState?.({ duration, playbackRate: 1, position: Math.min(time, duration) })
      }
    } catch { /* not every browser takes a position */ }
  }
}
