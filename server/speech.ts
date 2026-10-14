import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VOICE, MAX_PIECE_CHARS, isVoice, speechChunks, speechText, speedOf } from '../src/lib/speech.ts'

/**
 * The voice, from the speech server on this Mac: mlx-audio running Kokoro,
 * started by launchd as com.amie.lm-speech (see scripts/lm-speech). It speaks
 * OpenAI's /v1/audio/speech. Separate from LM Studio, which has no voice,
 * and from oMLX, which comes and goes with the coding models.
 */
export const SPEECH_URL = process.env.LM_SPEECH_URL || 'http://127.0.0.1:8020'
export const SPEECH_MODEL = process.env.LM_SPEECH_MODEL || 'mlx-community/Kokoro-82M-bf16'
/** A cold start loads the model (several seconds); a warm piece takes about one. */
const TIMEOUT_MS = 60_000

export class SpeechError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export interface SpeakRequest {
  text: unknown
  voice?: unknown
  speed?: unknown
}

/** Check a request from the page: one piece of text, and a known voice. */
export function readSpeakRequest(body: SpeakRequest, defaults: { voice: string; speed: string }): { text: string; voice: string; speed: number } {
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new SpeechError('Nothing to say.', 400)
  if (text.length > MAX_PIECE_CHARS) throw new SpeechError(`At most ${MAX_PIECE_CHARS} characters at a time.`, 400)
  const voice = isVoice(body.voice) ? body.voice : isVoice(defaults.voice) ? defaults.voice : DEFAULT_VOICE
  const speed = speedOf(body.speed ?? defaults.speed)
  return { text, voice, speed }
}

/** One piece of speech, as WAV. */
export async function synthesize(text: string, voice: string, speed: number, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  let res: Response
  try {
    res = await fetchImpl(`${SPEECH_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SPEECH_MODEL,
        input: text,
        voice,
        speed,
        lang_code: voice[0], // a = American English, b = British
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new SpeechError("The voice isn't running on the Mac (the speech server didn't answer).", 503)
  }
  const audio = Buffer.from(await res.arrayBuffer())
  // The server answers 200 even when the model fails partway; an empty body is the tell.
  if (!res.ok || audio.length < 100) {
    throw new SpeechError(`The voice couldn't read this (speech server answered ${res.status}${audio.length < 100 ? ', with no audio' : ''}).`, 502)
  }
  return audio
}

// --- a whole reply as one track ---------------------------------------------
//
// Read aloud piece by piece, a reply stops the moment the phone's screen goes
// off: between two pieces nothing is playing, so iOS suspends the page. One
// file for the whole reply, served with ranges, is what a phone treats as a
// track -- it plays on with the screen off, the lock screen shows it with a
// scrubber, and seeking is the browser's own. The voice renders about forty
// times faster than it speaks, so a long reply is ready in seconds.


export interface TrackStatus {
  /** The file name, which is also the track's identity. */
  name: string
  ready: boolean
  /** Pieces rendered so far, of how many. */
  done: number
  total: number
  /** Once ready: where to play it from, and how long it runs. */
  url?: string
  seconds?: number
  /** When rendering failed: why. The next request tries again. */
  error?: string
}

/** The samples of a WAV the speech server made (PCM, 16-bit mono at 24 kHz), with its format. */
export function pcmOf(wav: Buffer): { pcm: Buffer; rate: number; channels: number; bits: number } {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new SpeechError('The voice sent something that is not WAV.', 502)
  let pos = 12
  let format: { rate: number; channels: number; bits: number } | null = null
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4)
    const size = wav.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      format = { channels: wav.readUInt16LE(body + 2), rate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      if (!format) break
      // A streamed WAV may claim more data than it holds; take what is there.
      return { pcm: wav.subarray(body, Math.min(wav.length, body + size)), ...format }
    }
    pos = body + size + (size & 1)
  }
  throw new SpeechError('The voice sent WAV with no samples in it.', 502)
}

/** A WAV file around PCM samples. */
export function wavOf(pcm: Buffer, rate: number, channels: number, bits: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * bits / 8, 28)
  header.writeUInt16LE(channels * bits / 8, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Seconds of sound in a track file, from its size. */
export const trackSeconds = (bytes: number, rate = 24000, channels = 1, bits = 16): number =>
  Math.max(0, bytes - 44) / (rate * channels * bits / 8)

/** Tracks older than this are swept out when a new one is made. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const TRACK_NAME = /^[A-Za-z0-9_-]{1,80}-[a-f0-9]{10}\.(?:wav|m4a)$/

/** The media type a track file is served as. */
export const trackType = (name: string): string => (name.endsWith('.m4a') ? 'audio/mp4' : 'audio/wav')

/**
 * Turns the rendered WAV into a smaller file for the phone: a path in, a
 * path out. Null keeps the WAV.
 */
export type TrackEncoder = (wav: string, out: string) => Promise<void>

/**
 * AAC in an MP4, from macOS's own afconvert: six times smaller than the
 * WAV at 64 kb/s mono, which is plenty for one voice, and under a second
 * for ten minutes of speech. Over cellular that is the difference between
 * a track that starts at once and one that stalls.
 */
export const aacEncoder: TrackEncoder = (wav, out) => new Promise((resolve, reject) => {
  execFile('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac ', '-b', '64000', '-q', '127', '-s', '2', wav, out], { timeout: 120_000 }, (err, _stdout, stderr) => {
    if (err) reject(new Error(`afconvert: ${String(stderr || err.message).trim()}`))
    else resolve()
  })
})

/**
 * The tracks: rendered once each into `dir`, named for the reply and a hash
 * of what is said and in which voice, so an edited reply or a new voice is
 * a new file and an old one is simply never asked for again.
 */
export class Tracks {
  private jobs = new Map<string, { done: number; total: number; error?: string }>()
  private readonly fetchImpl: typeof fetch
  private readonly encoder: TrackEncoder | null

  constructor(private readonly dir: string, options: { fetchImpl?: typeof fetch; encoder?: TrackEncoder | null } = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...a) => fetch(...a))
    this.encoder = options.encoder === undefined ? aacEncoder : options.encoder
  }

  /** What a reply's track is called, before its extension: the reply, and a hash of the words, voice and speed. */
  static name(id: string, spoken: string, voice: string, speed: number): string {
    const hash = createHash('sha1').update(`${voice}\n${speed}\n${spoken}`).digest('hex').slice(0, 10)
    return `${id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${hash}`
  }

  /** The file for a name from the page, or null for anything that is not one of ours. */
  path(name: string): string | null {
    return TRACK_NAME.test(name) ? path.join(this.dir, name) : null
  }

  /** Where the track is: ready, on its way, or failed. Starts rendering it when none of those. */
  prepare(id: string, markdown: string, voice: string, speed: number): TrackStatus {
    const spoken = speechText(markdown)
    const pieces = speechChunks(spoken, MAX_PIECE_CHARS, MAX_PIECE_CHARS)
    if (!pieces.length) throw new SpeechError('Nothing to say.', 400)
    const name = Tracks.name(id, spoken, voice, speed)
    const status = this.status(name)
    if (status.ready) return status
    const job = this.jobs.get(name)
    if (job) return { name, ready: false, done: job.done, total: job.total }
    const fresh = { done: 0, total: pieces.length }
    this.jobs.set(name, fresh)
    void this.render(name, pieces, voice, speed, fresh)
    return { name, ready: false, done: 0, total: pieces.length }
  }

  /** The state of a track by name, for polling: the encoded file if there is one, else the WAV. */
  status(name: string): TrackStatus {
    const job = this.jobs.get(name)
    if (job?.error) {
      this.jobs.delete(name) // the next request tries again
      return { name, ready: false, done: job.done, total: job.total, error: job.error }
    }
    if (job) return { name, ready: false, done: job.done, total: job.total }
    for (const ext of ['m4a', 'wav']) {
      const file = path.join(this.dir, `${name}.${ext}`)
      let size: number
      try { size = fs.statSync(file).size } catch { continue }
      const seconds = ext === 'wav' ? trackSeconds(size) : this.secondsOf(name)
      return { name: `${name}.${ext}`, ready: true, done: 1, total: 1, url: `/api/speech/tracks/${name}.${ext}`, seconds }
    }
    return { name, ready: false, done: 0, total: 0 }
  }

  /** An encoded track's length, kept beside it: unlike a WAV's, it cannot be read off the size. */
  private secondsOf(name: string): number {
    try {
      const { seconds } = JSON.parse(fs.readFileSync(path.join(this.dir, `${name}.json`), 'utf8')) as { seconds?: unknown }
      return typeof seconds === 'number' ? seconds : 0
    } catch {
      return 0
    }
  }

  private async render(name: string, pieces: string[], voice: string, speed: number, job: { done: number; total: number; error?: string }): Promise<void> {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const parts: Buffer[] = []
      let format: { rate: number; channels: number; bits: number } | null = null
      for (const piece of pieces) {
        const { pcm, ...fmt } = pcmOf(await synthesize(piece, voice, speed, this.fetchImpl))
        format ??= fmt
        parts.push(pcm)
        job.done++
      }
      const pcm = Buffer.concat(parts)
      const { rate, channels, bits } = format!
      const base = path.join(this.dir, name)
      const wavPart = `${base}.part.wav`
      fs.writeFileSync(wavPart, wavOf(pcm, rate, channels, bits))
      if (this.encoder) {
        // Smaller for the phone; the WAV stays if the encoder fails.
        try {
          await this.encoder(wavPart, `${base}.part.m4a`)
          fs.writeFileSync(`${base}.json`, JSON.stringify({ seconds: trackSeconds(44 + pcm.length, rate, channels, bits) }))
          fs.renameSync(`${base}.part.m4a`, `${base}.m4a`)
          fs.unlinkSync(wavPart)
        } catch (err) {
          console.log(`[speech] track kept as WAV: ${(err as Error).message}`)
          fs.renameSync(wavPart, `${base}.wav`)
        }
      } else {
        fs.renameSync(wavPart, `${base}.wav`)
      }
      this.jobs.delete(name)
      this.sweep()
    } catch (err) {
      job.error = (err as Error).message
    }
  }

  /** Drop tracks nobody has asked for in a month, and any half-made file left by a crash. Best effort. */
  private sweep(): void {
    try {
      const cutoff = Date.now() - KEEP_MS
      for (const entry of fs.readdirSync(this.dir)) {
        const file = path.join(this.dir, entry)
        try {
          const stat = fs.statSync(file)
          const stale = /\.part\.(?:wav|m4a)$/.test(entry) && stat.mtimeMs < Date.now() - 60 * 60 * 1000
          if (stat.mtimeMs < cutoff || stale) fs.unlinkSync(file)
        } catch { /* gone already */ }
      }
    } catch { /* housekeeping only */ }
  }
}
