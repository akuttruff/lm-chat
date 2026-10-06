import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Speaker } from './speaker.ts'

/** An <audio> stand-in: play() resolves, and a test ends the current clip by hand. */
class FakeAudio {
  src = ''
  played: string[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = true
  ended = false
  play(): Promise<void> {
    this.played.push(this.src)
    this.paused = false
    this.ended = false
    return Promise.resolve()
  }
  pause(): void { this.paused = true }
  end(): void { this.ended = true; this.paused = true; this.onended?.() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

let urlCount = 0
beforeEach(() => {
  urlCount = 0
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: () => `blob:piece-${++urlCount}`,
    revokeObjectURL: () => {},
  }))
})

function setup(respond: (body: { text: string; voice?: string }) => Response | Promise<Response> = () => new Response(new Blob(['RIFF....'.repeat(20)]))) {
  const audio = new FakeAudio()
  const requests: { text: string; voice?: string; speed?: string }[] = []
  const errors: string[] = []
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text: string; voice?: string }
    requests.push(body)
    return respond(body)
  }) as unknown as typeof fetch
  const speaker = new Speaker(fetchImpl, () => audio as unknown as HTMLAudioElement, (m) => errors.push(m))
  return { speaker, audio, requests, errors }
}

const LONG = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} goes on for a little while so the pieces fill up.`).join(' ')

describe('Speaker', () => {
  it('plays a reply piece by piece, asking for the next while the current one plays', async () => {
    const { speaker, audio, requests } = setup()
    void speaker.speak('m1', LONG)
    // The tap itself plays a moment of silence, which is what lets iPhone Safari play the rest.
    expect(audio.played[0]).toMatch(/^data:audio\/wav;base64,/)
    expect(speaker.getState()).toEqual({ id: 'm1', status: 'loading' })
    await tick(); await tick()
    expect(audio.played[1]).toBe('blob:piece-1')
    expect(speaker.getState()).toEqual({ id: 'm1', status: 'playing' })
    expect(requests).toHaveLength(2) // the second piece is already on its way
    const pieces = requests.length
    audio.end(); await tick(); await tick()
    expect(audio.played[2]).toBe('blob:piece-2')
    expect(requests.length).toBe(pieces + 1)
    // Play to the end.
    for (let i = 0; i < 10 && speaker.getState().status !== 'idle'; i++) { audio.end(); await tick(); await tick() }
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
    expect(requests.map((r) => r.text).join(' ')).toBe(LONG)
  })

  it('sends a voice and speed only when asked to, leaving Settings to choose otherwise', async () => {
    const { speaker, requests } = setup()
    void speaker.speak('m1', 'Hello there.')
    void speaker.speak('preview', 'Hello there.', { voice: 'bf_emma', speed: '1.2' })
    await tick()
    expect(requests[0]).toEqual({ text: 'Hello there.' })
    expect(requests[1]).toEqual({ text: 'Hello there.', voice: 'bf_emma', speed: '1.2' })
  })

  it('pauses when the same reply is tapped again, resumes on the next tap, and switches when another is', async () => {
    const { speaker, audio } = setup()
    speaker.toggle('m1', LONG)
    await tick(); await tick()
    expect(speaker.getState()).toEqual({ id: 'm1', status: 'playing' })
    speaker.toggle('m1', LONG)
    expect(speaker.getState()).toEqual({ id: 'm1', status: 'paused' })
    expect(audio.paused).toBe(true)
    const before = audio.played.length
    speaker.toggle('m1', LONG)
    expect(speaker.getState()).toEqual({ id: 'm1', status: 'playing' })
    // The same piece carries on: nothing new is loaded, nothing is started over.
    expect(audio.played.slice(before)).toEqual(['blob:piece-1'])
    speaker.toggle('m2', 'Another reply.')
    expect(speaker.getState()).toEqual({ id: 'm2', status: 'loading' })
  })

  it('stops outright from stop(), paused or not', async () => {
    const { speaker, audio } = setup()
    speaker.toggle('m1', LONG)
    await tick(); await tick()
    speaker.pause()
    speaker.stop()
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
    expect(audio.paused).toBe(true)
    // A tap on a reply that's still loading stops it, since there's nothing to pause yet.
    speaker.toggle('m2', 'Another reply.')
    speaker.toggle('m2', 'Another reply.')
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
  })

  it('holds the next piece while paused between pieces, and plays it on resume', async () => {
    let releaseSecond: (r: Response) => void = () => {}
    let calls = 0
    const { speaker, audio } = setup(() => {
      calls++
      if (calls === 2) return new Promise<Response>((r) => { releaseSecond = r })
      return new Response(new Blob(['RIFF....'.repeat(20)]))
    })
    void speaker.speak('m1', LONG)
    await tick(); await tick()
    audio.end() // the first piece finishes; the second is still on its way
    await tick()
    speaker.pause()
    releaseSecond(new Response(new Blob(['RIFF....'.repeat(20)])))
    await tick(); await tick()
    expect(audio.played).toHaveLength(2) // silence and piece 1: piece 2 waits
    expect(speaker.getState().status).toBe('paused')
    speaker.resume()
    await tick(); await tick()
    expect(audio.played).toHaveLength(3)
    expect(speaker.getState()).toEqual({ id: 'm1', status: 'playing' })
  })

  it("says why when the voice can't be reached, and goes back to idle", async () => {
    const { speaker, errors } = setup(() => new Response(JSON.stringify({ error: "The voice isn't running on the Mac." }), { status: 503 }))
    await speaker.speak('m1', 'Hello.')
    expect(errors).toEqual(["The voice isn't running on the Mac."])
    expect(speaker.getState()).toEqual({ id: null, status: 'idle' })
  })

  it('has nothing to do for a reply with no words', async () => {
    const { speaker, requests } = setup()
    await speaker.speak('m1', '   ')
    expect(requests).toHaveLength(0)
    expect(speaker.getState().status).toBe('idle')
  })
})
