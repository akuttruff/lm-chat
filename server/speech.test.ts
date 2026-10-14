import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Tracks, aacEncoder, pcmOf, trackSeconds, trackType, wavOf } from './speech.ts'

/** A WAV the speech server might send: 16-bit mono at 24 kHz, `samples` of the given value. */
const wav = (samples: number, value = 1): Buffer => wavOf(Buffer.alloc(samples * 2, value), 24000, 1, 16)

describe('WAV in and out', () => {
  it('takes the samples out of a WAV and puts them back in one', () => {
    const { pcm, rate, channels, bits } = pcmOf(wav(10, 3))
    expect([rate, channels, bits]).toEqual([24000, 1, 16])
    expect(pcm).toEqual(Buffer.alloc(20, 3))
    const whole = wavOf(Buffer.concat([pcm, Buffer.alloc(4, 9)]), rate, channels, bits)
    expect(whole.length).toBe(44 + 24)
    expect(whole.readUInt32LE(40)).toBe(24)
    expect(pcmOf(whole).pcm.length).toBe(24)
  })

  it('reads a streamed WAV whose header claims more than it holds, and refuses what is not WAV', () => {
    const streamed = wav(10)
    streamed.writeUInt32LE(0xffffffff, 40)
    expect(pcmOf(streamed).pcm.length).toBe(20)
    expect(() => pcmOf(Buffer.from('not audio at all, sorry'))).toThrow(/not WAV/)
    expect(() => pcmOf(wav(10).subarray(0, 40))).toThrow(/no samples/)
  })

  it('knows how long a track file runs', () => {
    expect(trackSeconds(44 + 48000 * 90)).toBe(90)
    expect(trackSeconds(10)).toBe(0)
  })
})

describe('Tracks', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
  const fresh = () => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-tracks-')); return dir }

  it('names a track for its reply, words, voice and speed, in a form safe for a path', () => {
    const a = Tracks.name('m1', 'Hello.', 'af_heart', 1)
    expect(a).toMatch(/^m1-[a-f0-9]{10}$/)
    expect(Tracks.name('m1', 'Hello.', 'af_heart', 1.1)).not.toBe(a)
    expect(Tracks.name('m1', 'Hello!', 'af_heart', 1)).not.toBe(a)
    expect(Tracks.name('../../etc', 'Hello.', 'af_heart', 1)).toMatch(/^______etc-[a-f0-9]{10}$/)
    const tracks = new Tracks(fresh())
    expect(tracks.path(`${a}.wav`)).toBe(path.join(dir, `${a}.wav`))
    expect(tracks.path(`${a}.m4a`)).toBe(path.join(dir, `${a}.m4a`))
    expect(tracks.path('../secret.wav')).toBeNull()
    expect(tracks.path('m1-nothex.wav')).toBeNull()
    expect(tracks.path(`${a}.mp3`)).toBeNull()
    expect(trackType('x.m4a')).toBe('audio/mp4')
    expect(trackType('x.wav')).toBe('audio/wav')
  })

  it('renders a reply piece by piece into one file, reporting progress, then finds it ready', async () => {
    const voice = vi.fn(async () => new Response(new Uint8Array(wav(100))))
    const tracks = new Tracks(fresh(), { fetchImpl: voice as unknown as typeof fetch, encoder: null })
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} of this reply runs on for a while to fill the pieces up.`).join(' ')
    const first = tracks.prepare('m1', long, 'af_heart', 1)
    expect(first).toMatchObject({ ready: false, done: 0 })
    expect(first.total).toBeGreaterThan(1)
    // Asking again joins the same job rather than starting another.
    expect(tracks.prepare('m1', long, 'af_heart', 1).name).toBe(first.name)
    await vi.waitFor(() => expect(tracks.status(first.name).ready).toBe(true))
    const done = tracks.status(first.name)
    expect(done).toMatchObject({ name: `${first.name}.wav`, url: `/api/speech/tracks/${first.name}.wav`, seconds: (100 * first.total) / 24000 })
    expect(voice).toHaveBeenCalledTimes(first.total)
    const file = fs.readFileSync(tracks.path(`${first.name}.wav`)!)
    expect(pcmOf(file).pcm.length).toBe(200 * first.total)
    // Now it is simply there.
    expect(tracks.prepare('m1', long, 'af_heart', 1)).toMatchObject({ ready: true })
    expect(voice).toHaveBeenCalledTimes(first.total)
  })

  it("says why when the voice fails, and tries again on the next request", async () => {
    let calls = 0
    const voice = vi.fn(async () => (++calls === 1 ? new Response(Buffer.alloc(5), { status: 500 }) : new Response(new Uint8Array(wav(100)))))
    const tracks = new Tracks(fresh(), { fetchImpl: voice as unknown as typeof fetch, encoder: null })
    const first = tracks.prepare('m1', 'Hello there.', 'af_heart', 1)
    await vi.waitFor(() => expect(tracks.status(first.name).error).toBeTruthy())
    // The error was reported once; the next ask starts over.
    expect(tracks.status(first.name)).toMatchObject({ ready: false, done: 0, total: 0 })
    tracks.prepare('m1', 'Hello there.', 'af_heart', 1)
    await vi.waitFor(() => expect(tracks.status(first.name).ready).toBe(true))
  })

  it('shrinks the track with the encoder, keeping its length beside it, and keeps the WAV when the encoder fails', async () => {
    const voice = vi.fn(async () => new Response(new Uint8Array(wav(2400))))
    const encoder = vi.fn(async (_wav: string, out: string) => { fs.writeFileSync(out, 'aac bytes') })
    const tracks = new Tracks(fresh(), { fetchImpl: voice as unknown as typeof fetch, encoder })
    const first = tracks.prepare('m1', 'Hello there.', 'af_heart', 1)
    await vi.waitFor(() => expect(tracks.status(first.name).ready).toBe(true))
    expect(tracks.status(first.name)).toMatchObject({ name: `${first.name}.m4a`, url: `/api/speech/tracks/${first.name}.m4a`, seconds: 0.1 })
    expect(fs.readFileSync(path.join(dir, `${first.name}.m4a`), 'utf8')).toBe('aac bytes')
    expect(fs.readdirSync(dir).sort()).toEqual([`${first.name}.json`, `${first.name}.m4a`])
    const broken = new Tracks(fresh(), { fetchImpl: voice as unknown as typeof fetch, encoder: async () => { throw new Error('no afconvert') } })
    const second = broken.prepare('m2', 'Hello there.', 'af_heart', 1)
    await vi.waitFor(() => expect(broken.status(second.name).ready).toBe(true))
    expect(broken.status(second.name)).toMatchObject({ name: `${second.name}.wav`, seconds: 0.1 })
  })

  it.skipIf(!fs.existsSync('/usr/bin/afconvert'))('encodes AAC with afconvert on this Mac', async () => {
    const d = fresh()
    const source = path.join(d, 'in.wav')
    fs.writeFileSync(source, wav(24000)) // a second of silence
    await aacEncoder(source, path.join(d, 'out.m4a'))
    const out = fs.statSync(path.join(d, 'out.m4a')).size
    expect(out).toBeGreaterThan(100)
    expect(out).toBeLessThan(24000)
    await expect(aacEncoder(path.join(d, 'missing.wav'), path.join(d, 'x.m4a'))).rejects.toThrow(/afconvert/)
  })

  it('refuses a reply with nothing to say', () => {
    const tracks = new Tracks(fresh())
    expect(() => tracks.prepare('m1', '```\ncode\n```', 'af_heart', 1)).not.toThrow() // "There is a code block here."
    expect(() => tracks.prepare('m1', '   ', 'af_heart', 1)).toThrow(/Nothing to say/)
  })
})
