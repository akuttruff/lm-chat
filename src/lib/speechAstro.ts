/**
 * Astrology, said aloud. A forecast reads well with its symbols -- Jupiter
 * ☐ Sun, 20°36' Leo, 9th → 6th -- but a voice reads them as "ballot box"
 * and "right arrow". This turns them into the words an astrologer would say:
 * aspects by name, positions by sign, houses as "your 9th house", and a
 * transit table row into one sentence:
 *
 *   | Jupiter ☐ square Sun | 20°36' Leo ☐ 20°38' Taurus | 9th → 6th | Vision vs. action |
 *   Jupiter in Leo, your 9th house, is squaring your Sun in Taurus, in your 6th house. Vision vs. action.
 *
 * Only for speech: what's on screen keeps its symbols. Runs on plain text
 * (bold and italic marks already gone), before the table and list cleanup
 * in speechText.
 */

const PLANET_GLYPHS: Record<string, string> = {
  '☉': 'Sun', '☽': 'Moon', '☾': 'Moon', '☿': 'Mercury', '♀': 'Venus', '♂': 'Mars', '♃': 'Jupiter', '♄': 'Saturn',
  '♅': 'Uranus', '⛢': 'Uranus', '♆': 'Neptune', '♇': 'Pluto', '⚷': 'Chiron', '☊': 'North Node', '☋': 'South Node',
}
const SIGN_GLYPHS: Record<string, string> = {
  '♈': 'Aries', '♉': 'Taurus', '♊': 'Gemini', '♋': 'Cancer', '♌': 'Leo', '♍': 'Virgo',
  '♎': 'Libra', '♏': 'Scorpio', '♐': 'Sagittarius', '♑': 'Capricorn', '♒': 'Aquarius', '♓': 'Pisces',
}
/** Each aspect's symbols, its name, and how it reads as a verb ("is squaring"). */
const ASPECTS: { symbols: string; name: string; verb: string; words: string }[] = [
  { symbols: '☌', name: 'conjunct', verb: 'is conjunct', words: 'conjunction|conjunct|conjoins|conjoining' },
  { symbols: '☍', name: 'opposite', verb: 'is opposing', words: 'opposition|opposite|opposes|opposing' },
  { symbols: '☐□◻', name: 'square', verb: 'is squaring', words: 'square|squares|squaring' },
  { symbols: '△', name: 'trine', verb: 'is trining', words: 'trine|trines|trining' },
  { symbols: '✶⚹✱', name: 'sextile', verb: 'is sextiling', words: 'sextile|sextiles|sextiling' },
  { symbols: '⚻', name: 'quincunx', verb: 'is quincunx', words: 'quincunx|inconjunct' },
  { symbols: '⚺', name: 'semi-sextile', verb: 'is semi-sextile', words: 'semi-sextile|semisextile' },
]
const ALL_ASPECT_SYMBOLS = ASPECTS.map((a) => a.symbols).join('')
const ASPECT_WORD = ASPECTS.map((a) => a.words).join('|')
const aspectOf = (word: string): (typeof ASPECTS)[number] | undefined =>
  ASPECTS.find((a) => new RegExp(`^(?:${a.words})$`, 'i').test(word))

const SIGNS = Object.values(SIGN_GLYPHS)
const SIGN = `(?:${SIGNS.join('|')})`
const POINTS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Chiron',
  'North Node', 'South Node', 'Ascendant', 'Descendant', 'Midheaven', 'IC', 'Lilith', 'Part of Fortune', 'Vertex']
const POINT = `(?:${POINTS.join('|')})`
/** "the Sun", "the North Node", but "Jupiter". */
const withThe = (p: string): string => (/^(Sun|Moon|North Node|South Node|Ascendant|Descendant|Midheaven|Part of Fortune|Vertex)$/.test(p) ? `the ${p}` : p)
const yourPoint = (p: string): string => `your ${p}`
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const FRACTIONS: Record<string, string> = { '½': 'one half', '⅓': 'one third', '⅔': 'two thirds', '¼': 'one quarter', '¾': 'three quarters' }

/** "20°36'" -> "20 degrees"; the arc-minutes are more than an ear needs. */
const DEGREE = `\\d{1,2}°(?:\\s?\\d{1,2}\\s?['′’]?)?`

export function astroSpeech(text: string): string {
  let s = text

  // --- glyphs to names ------------------------------------------------------
  s = s.replace(/[︎️]/g, '') // text/emoji presentation selectors
  // A planet glyph that only decorates a heading ("☽ Daily Forecast") goes.
  s = s.replace(new RegExp(`^(#{1,6}[ \\t]*)[${Object.keys(PLANET_GLYPHS).join('')}][ \\t]+`, 'gm'), '$1')
  s = s.replace(/[☉☽☾☿♀♂♃♄♅⛢♆♇⚷☊☋]/g, (g) => ` ${PLANET_GLYPHS[g]} `)
  s = s.replace(/[♈♉♊♋♌♍♎♏♐♑♒♓]/g, (g) => ` ${SIGN_GLYPHS[g]} `)
  s = s.replace(/℞/g, ' retrograde ')
  // "Venus ♀" said "Venus Venus": a glyph beside its own name says it once.
  s = s.replace(new RegExp(`\\b(${[...Object.values(PLANET_GLYPHS), ...Object.values(SIGN_GLYPHS)].join('|')})[ \\t]+\\1\\b`, 'g'), '$1')
  s = s.replace(/\bAsc\b\.?/g, 'Ascendant').replace(/\bDsc\b\.?/g, 'Descendant').replace(/\bMC\b/g, 'Midheaven')

  // --- aspect symbols -------------------------------------------------------
  // Spelled out beside its symbol already -- "☐ (square)", "☐ square" -- the word stays, the symbol goes.
  s = s.replace(new RegExp(`[${ALL_ASPECT_SYMBOLS}][ \\t]*\\(?(${ASPECT_WORD})\\)?`, 'gi'), '$1')
  // A symbol opening a line or cell whose words name the aspect anyway: "☐ Sun square Jupiter".
  s = s.replace(new RegExp(`(^|\\|)([ \\t]*)[${ALL_ASPECT_SYMBOLS}][ \\t]+(?=[^|\\n]*\\b(?:${ASPECT_WORD})\\b)`, 'gim'), '$1$2')
  // Any other: its name.
  for (const a of ASPECTS) s = s.replace(new RegExp(`[${a.symbols}]`, 'g'), ` ${a.name} `)

  // --- a transit table row, as one sentence -----------------------------------
  // | Jupiter square Sun | 20°36' Leo square 20°38' Taurus | 9th → 6th | meaning... |
  const row = new RegExp(
    `^[ \\t]*\\|[ \\t]*(?:transiting[ \\t]+)?(${POINT})[ \\t]+(${ASPECT_WORD})[ \\t]+(?:your[ \\t]+|natal[ \\t]+)?(${POINT})[ \\t]*` +
    `\\|[ \\t]*(?:${DEGREE})?[ \\t]*(${SIGN})[ \\t]+(?:${ASPECT_WORD})[ \\t]+(?:${DEGREE})?[ \\t]*(${SIGN})[ \\t]*` +
    `\\|[ \\t]*(\\d{1,2}(?:st|nd|rd|th))(?:[ \\t]+house)?[ \\t]*(?:→|->|to)[ \\t]*(\\d{1,2}(?:st|nd|rd|th))(?:[ \\t]+house)?[ \\t]*` +
    `\\|(.*?)\\|?[ \\t]*$`,
    'gim',
  )
  s = s.replace(row, (_m, a: string, aspect: string, b: string, signA: string, signB: string, houseA: string, houseB: string, rest: string) => {
    const verb = aspectOf(aspect)?.verb ?? aspect
    const notes = rest.split('|').map((c) => c.trim()).filter(Boolean).join('. ')
    return `${capitalise(withThe(a))} in ${signA}, your ${houseA} house, ${verb} ${yourPoint(b)} in ${signB}, in your ${houseB} house.${notes ? ` ${endSentence(notes)}` : ''}`
  })

  // "Moon trine Mercury (27°30' Leo trine 27°30' Aries, house 5)": who's where, then the house.
  s = s.replace(
    new RegExp(`\\b(${POINT})[ \\t]+(${ASPECT_WORD})[ \\t]+(?:your[ \\t]+|natal[ \\t]+)?(${POINT})[ \\t]*\\([ \\t]*(?:${DEGREE})?[ \\t]*(${SIGN})[ \\t]+(?:${ASPECT_WORD})[ \\t]+(?:${DEGREE})?[ \\t]*(${SIGN})(?:,[ \\t]*house[ \\t]+(\\d{1,2}))?[ \\t]*\\)`, 'gi'),
    (_m, a: string, aspect: string, b: string, signA: string, signB: string, house?: string) =>
      `${withThe(a)} in ${signA} ${aspectOf(aspect)?.verb ?? aspect} ${b} in ${signB}${house ? `, in your ${ordinal(Number(house))} house` : ''}`,
  )

  // --- positions -----------------------------------------------------------
  // "Sun 13°00′ Libra" -> "Sun in Libra"; a position on its own -> "20 degrees Leo".
  s = s.replace(new RegExp(`\\b(${POINT})[ \\t]+(?:${DEGREE})[ \\t]*(${SIGN})\\b`, 'g'), '$1 in $2')
  s = s.replace(/\b(\d{1,2})°(?:\s?\d{1,2}\s?['′’]?)?/g, (_m, d: string) => `${d} ${d === '1' ? 'degree' : 'degrees'}`)

  // "Jupiter square your Sun" reads better as "Jupiter is squaring your Sun" -- unless a verb follows
  // ("Sun square Jupiter was exact yesterday"), where the noun is the subject and has to stay one.
  s = s.replace(
    new RegExp(`\\b(${POINT})((?:[ \\t]+in[ \\t]+${SIGN})?)[ \\t]+(${ASPECT_WORD})[ \\t]+(your|natal)[ \\t]+(${POINT})\\b(?![ \\t]+(?:is|was|were|are|will|has|had|stays|becomes|perfects|goes)\\b)`, 'g'),
    (_m, a: string, where: string, aspect: string, _your: string, b: string) => `${a}${where} ${aspectOf(aspect)?.verb ?? aspect} your ${b}`,
  )

  // --- houses and arrows ---------------------------------------------------
  s = s.replace(/\b(\d{1,2}(?:st|nd|rd|th))(?:[ \t]+house)?[ \t]*(?:→|->)[ \t]*(\d{1,2}(?:st|nd|rd|th))(?![ \t]+house)\b/g, 'your $1 house to your $2 house')
  s = s.replace(new RegExp(`\\b(${SIGN})[ \\t]*(?:→|->)[ \\t]*(${SIGN})\\b`, 'g'), '$1, moving into $2')
  s = s.replace(/[ \t]*↔[ \t]*/g, ' and ')
  s = s.replace(/[ \t]*←[ \t]*/g, ' from ')
  // Toward a date or a number, an arrow is "to": "Now → Feb 2027", "10-13 → 2027-02-08".
  s = s.replace(new RegExp(`[ \\t]*(?:→|->)[ \\t]*(?=\\d|(?:${MONTHS.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\b)`, 'g'), ' to ')
  // An arrow ending a label ("18 mo →  I can be patient") is a pause; between two things, "to".
  s = s.replace(/[ \t]*(?:→|->)[ \t]*(?=$|\n|[A-Z"“*_(])/gm, ': ')
  s = s.replace(/[ \t]*(?:→|⟶|➔|➜|->)[ \t]*/g, ' to ')

  // --- numbers and comparisons ---------------------------------------------
  s = s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
    const month = MONTHS[Number(mo) - 1]
    return month ? `${month} ${Number(d)}, ${y}` : m
  })
  s = s.replace(/(?<![\d-])\b(\d{2})-(\d{2})\b(?![\d-])/g, (m, mo: string, d: string) => {
    const month = MONTHS[Number(mo) - 1]
    return month && Number(d) >= 1 && Number(d) <= 31 ? `${month} ${Number(d)}` : m
  })
  s = s.replace(/≥\s*/g, 'at least ').replace(/≤\s*/g, 'at most ').replace(/≈\s*/g, 'about ').replace(/\s*≠\s*/g, ' is not ')
  s = s.replace(/(^|\s)<\s*(?=\d)/g, '$1under ').replace(/(^|\s)>\s*(?=\d)/g, '$1over ')
  s = s.replace(/\b(\d+)\s?mo\b/g, (_m, n: string) => `${n} ${n === '1' ? 'month' : 'months'}`)
  s = s.replace(/[½⅓⅔¼¾]/g, (f) => ` ${FRACTIONS[f]} `)
  s = s.replace(/[①-⑳]/g, (c) => `${c.charCodeAt(0) - 0x245f}.`)

  // --- decoration ------------------------------------------------------------
  // Emoji and check marks are for the eye; read aloud they're noise ("crescent moon", "white heavy check mark").
  s = s.replace(/\p{Extended_Pictographic}/gu, '')
  s = s.replace(/[✓✔✗✘]/g, '')

  return s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1')
}

/** Ends with a full stop unless it already ends a sentence ('"am I overthinking?"'). */
const endSentence = (s: string): string => (/[.!?…]["'”’)]*$/.test(s) ? s : `${s}.`)

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${tail}`
}

/**
 * How the voice should say the bodies an astrologer names, in Kokoro's own
 * phoneme spelling (misaki's: A = "ay", I = "eye", O = "oh", W = "ow";
 * ˈ marks the stressed syllable). Most it already says right; these pin the
 * astrologer's pronunciation, or rescue a name it doesn't know at all
 * (it reads Makemake as "make-make").
 */
export const PRONUNCIATIONS: Record<string, string> = {
  Uranus: 'jˈʊɹənəs', // YOOR-uh-nus
  Chiron: 'kˈIɹɑn', // KY-ron
  Ceres: 'sˈɪɹiz', // SEER-eez
  Pallas: 'pˈæləs',
  Juno: 'ʤˈunO',
  Vesta: 'vˈɛstə',
  Eris: 'ˈɛɹɪs', // AIR-iss
  Lilith: 'lˈɪlɪθ',
  Sedna: 'sˈɛdnə',
  Makemake: 'mˌɑkAmˈɑkA', // MAH-kay-MAH-kay
  Haumea: 'hˌWmˈAə', // how-MAY-uh
  Quaoar: 'kwˈɑwɑɹ', // KWAH-war
  Orcus: 'ˈɔɹkəs',
  Pisces: 'pˈIsiz', // PY-seez
  Aries: 'ˈɛɹiz', // AIR-eez
}

/**
 * Mark each of those names with its pronunciation, as Kokoro reads it:
 * "[Chiron](/kˈIɹɑn/)". The last step before the text goes to the voice --
 * anything after would read the brackets as a link -- and never shown.
 * A possessive ("Chiron's") is left to the voice, which handles it.
 */
export function withPronunciations(text: string): string {
  const names = Object.keys(PRONUNCIATIONS).join('|')
  return text.replace(new RegExp(`(?<![\\w\\[/])(${names})(?![\\w'’\\]])`, 'g'), (name: string) => `[${name}](/${PRONUNCIATIONS[name]}/)`)
}
