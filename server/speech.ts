import { DEFAULT_VOICE, MAX_PIECE_CHARS, isVoice, speedOf } from '../src/lib/speech.ts'

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
