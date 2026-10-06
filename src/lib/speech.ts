import { astroSpeech, withPronunciations } from './speechAstro.ts'

/**
 * Reading a reply aloud: what to say, and in what pieces.
 *
 * The voice is Kokoro, a small speech model served on this Mac by mlx-audio
 * (see scripts/lm-speech). Shared by the server, which sends each piece to
 * it, and the page, which plays the pieces in order.
 */

export interface Voice {
  id: string
  name: string
  group: string
}

/**
 * Kokoro's English voices. The first letter is the accent (a = American,
 * b = British), the second the voice's gender; the speech server needs the
 * accent to pronounce words right, and takes it from the id.
 */
export const VOICES: Voice[] = [
  ...[['af_heart', 'Heart'], ['af_bella', 'Bella'], ['af_nicole', 'Nicole'], ['af_aoede', 'Aoede'], ['af_kore', 'Kore'],
    ['af_sarah', 'Sarah'], ['af_nova', 'Nova'], ['af_sky', 'Sky'], ['af_alloy', 'Alloy'], ['af_jessica', 'Jessica'], ['af_river', 'River']]
    .map(([id, name]) => ({ id: id!, name: name!, group: 'American, female' })),
  ...[['am_michael', 'Michael'], ['am_fenrir', 'Fenrir'], ['am_puck', 'Puck'], ['am_echo', 'Echo'], ['am_eric', 'Eric'],
    ['am_liam', 'Liam'], ['am_onyx', 'Onyx'], ['am_adam', 'Adam']]
    .map(([id, name]) => ({ id: id!, name: name!, group: 'American, male' })),
  ...[['bf_emma', 'Emma'], ['bf_isabella', 'Isabella'], ['bf_alice', 'Alice'], ['bf_lily', 'Lily']]
    .map(([id, name]) => ({ id: id!, name: name!, group: 'British, female' })),
  ...[['bm_george', 'George'], ['bm_fable', 'Fable'], ['bm_lewis', 'Lewis'], ['bm_daniel', 'Daniel']]
    .map(([id, name]) => ({ id: id!, name: name!, group: 'British, male' })),
]

export const DEFAULT_VOICE = 'af_heart'
export const SPEEDS = ['0.9', '1', '1.1', '1.2', '1.35'] as const
export const DEFAULT_SPEED = '1'

export const isVoice = (v: unknown): v is string => typeof v === 'string' && VOICES.some((x) => x.id === v)
/** A speed the voice can be asked for: the listed ones, or anything sane typed into the database by hand. */
export function speedOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1
}

/** The longest piece sent to the voice at once. Longer text is split first. */
export const MAX_PIECE_CHARS = 1500

/**
 * A reply's markdown as words to say. Formatting marks go; code is not read
 * out symbol by symbol but named once; links read as their text; a table
 * reads row by row.
 */
export function speechText(markdown: string): string {
  let s = markdown.replace(/\r\n?/g, '\n')
  // Fenced code: one short mention, so the listener knows something was skipped.
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[^\n]*|(?![\s\S]))/gm, '\n(There is a code block here.)\n')
  s = s.replace(/<[^>\n]+>/g, ' ') // HTML tags
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '') // images
  s = s.replace(/\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)/g, '$1') // links: their text
  s = s.replace(/\bhttps?:\/\/\S+/g, 'a link')
  // Emphasis goes before anything reads the words, so "**Jupiter ☐ Sun**" is just the words.
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2') // bold, italic
  s = s.replace(/~~(.+?)~~/g, '$1')
  s = astroSpeech(s) // symbols, degrees, houses and arrows, as words (see speechAstro.ts)
  // Tables: drop the |---| rule, read the cells of each row as a list.
  s = s.replace(/^(?=[^\n]*\|)(?=[^\n]*-)[ \t|:-]+(?:\n|$)/gm, '')
  s = s.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => {
    const line = row.split('|').map((c) => c.trim()).filter(Boolean).join(', ')
    return /[.!?…]["'”’)]*$/.test(line) ? line : `${line}.`
  })
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, '$1.') // headings: a sentence of their own
  s = s.replace(/^[ \t]*>[ \t]?/gm, '') // quotes
  s = s.replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/gm, '') // list markers and task boxes
  s = s.replace(/^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, '') // horizontal rules
  s = s.replace(/`([^`\n]+)`/g, '$1') // inline code: just the words
  s = s.replace(/\.{2,}(?=\.)/g, '') // "heading:." from the heading rule above
  s = s.replace(/([:;!?])\./g, '$1')
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
  // Last: how to say the names the voice gets wrong (see PRONUNCIATIONS). Only the voice sees these.
  return withPronunciations(s.trim())
}

/** Split text at sentence ends, keeping the punctuation with its sentence. */
function sentences(text: string): string[] {
  return text.match(/[^.!?…]+(?:[.!?…]+["')\]]*\s*|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [text]
}

/** A piece too long even as one sentence, cut at a comma or space instead. */
function hardSplit(text: string, max: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
    const at = cut > max / 2 ? cut + 1 : (window.lastIndexOf(' ') > max / 2 ? window.lastIndexOf(' ') : max)
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

/**
 * The text in pieces to synthesise one after another: the first one short,
 * so the voice starts within a moment, the rest a few sentences each, so the
 * next is ready before the current one ends. Pieces break only between
 * sentences, which is where a pause sounds natural.
 */
export function speechChunks(text: string, firstMax = 180, max = 600): string[] {
  const units = text.split(/\n+/).flatMap((para) => sentences(para.trim())).flatMap((s) => hardSplit(s, max))
  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    const limit = chunks.length === 0 ? firstMax : max
    if (current && current.length + 1 + unit.length > limit) {
      chunks.push(current)
      current = unit
    } else {
      current = current ? `${current} ${unit}` : unit
    }
  }
  if (current) chunks.push(current)
  return chunks
}
