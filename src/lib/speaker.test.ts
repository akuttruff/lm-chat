import { describe, it, expect, vi } from 'vitest'
import { IDLE, Speaker, clock } from './speaker.ts'

/** An <audio> stand-in: play() resolves, and a test moves or ends the track by hand. */
class FakeAudio {
  src = ''
  loop = false
  currentTime = 0
  duration = 0
  played: string[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeupdate: (() => void) | null = null
  ondurationchange: (() => void) | null = null
  paused = true
  play(): Promise<void> {
    this.played.push(this.src)
    this.paused = false
    return Promise.resolve()
  }
  pause(): void { this.paused = true }
  /** The browser learns the length, then plays to `t`. */
  at(t: number, duration = 240): void {
    if (this.duration !== duration) { this.duration = duration; this.ondurationchange?.() }
    this.currentTime = t
    this.ontimeupdate?.()
  }
  end(): void { this.paused = true; this.onended?.() }
}

/** A lock screen stand-in. */
class FakeSession {
  metadata: unknown = null
  playbackState = 'none'
  handlers = new Map<string, (d: Record<string, unknown>) => void>()
  positions: { duration: number; position: number }[] = []
  setActionHandler(action: string, handler: (d: Record<string, unknown>) => void): void { this.handlers.set(action, handler) }
  setPositionState(s: { duration: number; position: number }): void { this.positions.push(s) }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

type Answer = { name: string; ready: boolean; done: number; total: number; url?: string; seconds?: number; error?: string }

function setup(answers: (Answer | { status: number; error: string })[] = [{ name: 't.wav', ready: true, done: 1, total: 1, url: '/api/speech/tracks/t.wav', seconds: 240 }]) {
  const audio = new FakeAudio()
  const session = new FakeSession()
  const requests: { id: string; text: string; voice?: string; speed?: string }[] = []
  const errors: string[] = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as { id: string; text: string })
    const next = answers.length > 1 ? answers.shift()! : answers[0]!
    if ('status' in next) return new Response(JSON.stringify({ error: next.error }), { status: next.status })
    return new Response(JSON.stringify(next), { status: 200 })
  }) as unknown as typeof fetch
  vi.stubGlobal('MediaMetadata', class { constructor(readonly init: unknown) {} })
  const speaker = new Speaker(fetchImpl, () => audio as unknown as HTMLAudioElement, (m) => errors.push(m), session as unknown as MediaSession, 0)
  return { speaker, audio, session, requests, errors }
}

describe('Speaker', () => {
  it('asks for the reply as one track, plays it, and reports where it is', async () => {
    const { speaker, audio, requests, session } = setup()
    void speaker.speak('m1', 'Hello **there**.', { title: 'Forecast' })
    // The tap itself plays a loop of silence, which is what lets iPhone Safari play the rest and keeps the page awake.
    expect(audio.played[0]).toMatch(/^data:audio\/wav;base64,/)
    expect(audio.loop).toBe(true)
    expect(speaker.getState()).toMatchObject({ id: 'm1', status: 'preparing' })
    expect((session.metadata as { init: { title: string } }).init.title).toBe('Forecast')
    await tick(); await tick(); await tick()
    expect(requests).toEqual([{ id: 'm1', text: 'Hello **there**.' }])
    expect(audio.played[1]).toBe('/api/speech/tracks/t.wav')
    expect(audio.loop).toBe(false)
    expect(speaker.getState()).toMatchObject({ id: 'm1', status: 'playing', duration: 240, time: 0 })
    audio.at(12.5)
    expect(speaker.getState()).toMatchObject({ time: 12.5, duration: 240 })
    expect(session.playbackState).toBe('playing')
    expect(session.positions.at(-1)).toMatchObject({ duration: 240, position: 12.5 })
    audio.end()
    expect(speaker.getState()).toEqual(IDLE)
  })

  it('shows the rendering progress until the track is ready', async () => {
    const { speaker, audio } = setup([
      { name: 't.wav', ready: false, done: 0, total: 3 },
      { name: 't.wav', ready: false, done: 2, total: 3 },
      { name: 't.wav', ready: true, done: 3, total: 3, url: '/api/speech/tracks/t.wav', seconds: 90 },
    ])
    void speaker.speak('m1', 'Long reply.')
    await tick(); await tick()
    expect(speaker.getState()).toMatchObject({ status: 'preparing', total: 3 })
    await vi.waitFor(() => expect(speaker.getState().status).toBe('playing'))
    expect(audio.played.at(-1)).toBe('/api/speech/tracks/t.wav')
    expect(speaker.getState().duration).toBe(90)
  })

  it('pauses when the same reply is tapped again, resumes on the next tap, and switches when another is', async () => {
    const { speaker, audio, requests } = setup()
    speaker.toggle('m1', 'One.')
    await vi.waitFor(() => expect(speaker.getState().status).toBe('playing'))
    speaker.toggle('m1', 'One.')
    expect(speaker.getState().status).toBe('paused')
    expect(audio.paused).toBe(true)
    speaker.toggle('m1', 'One.')
    expect(speaker.getState().status).toBe('playing')
    expect(audio.paused).toBe(false)
    speaker.toggle('m2', 'Two.')
    await vi.waitFor(() => expect(speaker.getState()).toMatchObject({ id: 'm2', status: 'playing' }))
    expect(requests.map((r) => r.id)).toEqual(['m1', 'm2'])
  })

  it('seeks and skips within the track, from the page or the lock screen', async () => {
    const { speaker, audio, session } = setup()
    void speaker.speak('m1', 'One.')
    await vi.waitFor(() => expect(speaker.getState().status).toBe('playing'))
    speaker.seek(100)
    expect(audio.currentTime).toBe(100)
    expect(speaker.getState().time).toBe(100)
    speaker.skip(15)
    expect(audio.currentTime).toBe(115)
    session.handlers.get('seekto')!({ seekTime: 30 })
    expect(audio.currentTime).toBe(30)
    session.handlers.get('seekbackward')!({})
    expect(audio.currentTime).toBe(15)
    speaker.seek(1000)
    expect(audio.currentTime).toBe(240) // no further than the end
    session.handlers.get('pause')!({})
    expect(speaker.getState().status).toBe('paused')
    session.handlers.get('play')!({})
    expect(speaker.getState().status).toBe('playing')
  })

  it('stops outright from stop(), and a tap while preparing stops too', async () => {
    const { speaker, audio } = setup([{ name: 't.wav', ready: false, done: 0, total: 5 }])
    speaker.toggle('m1', 'One.')
    await tick(); await tick()
    expect(speaker.getState().status).toBe('preparing')
    speaker.toggle('m1', 'One.')
    expect(speaker.getState()).toEqual(IDLE)
    expect(audio.paused).toBe(true)
    expect(audio.loop).toBe(false)
  })

  it("says why when the voice can't render the reply, and goes back to idle", async () => {
    const { speaker, errors } = setup([{ status: 503, error: "The voice isn't running on the Mac." }])
    await speaker.speak('m1', 'One.')
    expect(errors).toEqual(["The voice isn't running on the Mac."])
    expect(speaker.getState()).toEqual(IDLE)
    const failed = setup([{ name: 't.wav', ready: false, done: 1, total: 2, error: 'The voice sent WAV with no samples in it.' }])
    await failed.speaker.speak('m1', 'One.')
    expect(failed.errors).toEqual(['The voice sent WAV with no samples in it.'])
  })

  it('tells the time like a music player', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(65.9)).toBe('1:05')
    expect(clock(3750)).toBe('1:02:30')
    expect(clock(-3)).toBe('0:00')
  })

  it('has nothing to do for a reply with no words', async () => {
    const { speaker, requests } = setup()
    await speaker.speak('m1', '   ')
    expect(requests).toHaveLength(0)
    expect(speaker.getState()).toEqual(IDLE)
  })
})
