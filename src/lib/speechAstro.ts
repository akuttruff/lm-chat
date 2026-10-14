/**
 * Astrology, said aloud. A forecast reads well with its symbols -- Jupiter
 * ☐ Sun, 20°36' Leo, 9th → 6th -- but a voice reads them as "ballot box"
 * and "right arrow". This turns them into the words an astrologer would say:
 * aspects by name, positions by sign, houses as "your 9th house", and a
 * transit table row into one sentence:
 *
 *   | Jupiter ☐ square Sun | 20°36' Leo ☐ 20°38' Taurus | 9th → 6th | Vision vs. action |
 *   Jupiter in Leo, your 9th house, squaring your Sun in Taurus, in your 6th house. Vision vs. action.
 *
 * The aspect in that sentence is worked out from the two positions when
 * both are given, not taken from the symbol: the model that writes the
 * table picks the wrong symbol often enough (a Saturn glyph for a sextile),
 * and the positions come straight from the chart.
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
/** Each aspect: its symbols, its angle and the orb within which two positions make it, its name, and how it reads as a verb ("squaring"). */
interface Aspect { symbols: string; angle: number; orb: number; name: string; verb: string; words: string }
const ASPECTS: Aspect[] = [
  { symbols: '☌', angle: 0, orb: 8, name: 'conjunct', verb: 'conjunct', words: 'conjunction|conjunct|conjoins|conjoining' },
  { symbols: '☍', angle: 180, orb: 8, name: 'opposite', verb: 'opposing', words: 'opposition|opposite|opposes|opposing' },
  { symbols: '☐□◻', angle: 90, orb: 8, name: 'square', verb: 'squaring', words: 'square|squares|squaring' },
  { symbols: '△', angle: 120, orb: 8, name: 'trine', verb: 'trining', words: 'trine|trines|trining' },
  { symbols: '✶⚹✱', angle: 60, orb: 6, name: 'sextile', verb: 'sextiling', words: 'sextile|sextiles|sextiling' },
  { symbols: '⚻', angle: 150, orb: 3, name: 'quincunx', verb: 'quincunx', words: 'quincunx|inconjunct' },
  { symbols: '⚺', angle: 30, orb: 3, name: 'semi-sextile', verb: 'semi-sextile', words: 'semi-sextile|semisextile' },
]
const ALL_ASPECT_SYMBOLS = ASPECTS.map((a) => a.symbols).join('')
const ASPECT_WORD = ASPECTS.map((a) => a.words).join('|')
const aspectOf = (word: string): Aspect | undefined =>
  ASPECTS.find((a) => new RegExp(`^(?:${a.words})$`, 'i').test(word))
/** The aspect a cell names, by symbol or word, if it names one. */
const aspectIn = (text: string): Aspect | undefined =>
  ASPECTS.find((a) => new RegExp(`[${a.symbols}]|(?<![A-Za-z-])(?:${a.words})(?![A-Za-z-])`, 'i').test(text))

/** The aspect two longitudes make, if they are within orb of one. */
function aspectBetween(a: number, b: number): Aspect | undefined {
  const apart = Math.abs(((a - b) % 360 + 360) % 360)
  const sep = Math.min(apart, 360 - apart)
  let best: Aspect | undefined
  for (const asp of ASPECTS) {
    const off = Math.abs(sep - asp.angle)
    if (off <= asp.orb && (!best || off < Math.abs(sep - best.angle))) best = asp
  }
  return best
}

const SIGNS = Object.values(SIGN_GLYPHS)
const SIGN = `(?:${SIGNS.join('|')})`
/** A sign in full or as a table's three letters: "Sco", "Vir". */
const SIGN_ANY = `(?:${SIGNS.join('|')}|Scorp|Sagg|${SIGNS.map((x) => x.slice(0, 3)).join('|')})`
const fullSign = (text: string): string => SIGNS.find((x) => x.toLowerCase().startsWith(text.toLowerCase().slice(0, 3))) ?? text
const POINTS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Chiron',
  'North Node', 'South Node', 'Ascendant', 'Descendant', 'Midheaven', 'IC', 'Lilith', 'Part of Fortune', 'Vertex']
const POINT = `(?:${POINTS.join('|')})`
/** A point as a table writes it: its name, a short form, or its glyph. */
const POINT_SHORT: Record<string, string> = {
  Asc: 'Ascendant', ASC: 'Ascendant', AC: 'Ascendant', Dsc: 'Descendant', DSC: 'Descendant', DC: 'Descendant', MC: 'Midheaven',
  'True Node': 'North Node', 'Mean Node': 'North Node', 'N. Node': 'North Node', 'S. Node': 'South Node', NN: 'North Node', SN: 'South Node',
}
const POINT_ANY = `(?:${[...POINTS, ...Object.keys(POINT_SHORT).map((k) => k.replace('.', '\\.'))].join('|')}|[${Object.keys(PLANET_GLYPHS).join('')}])`
const pointName = (text: string): string => PLANET_GLYPHS[text] ?? POINT_SHORT[text] ?? text
/** "the Sun", "the North Node", but "Jupiter". */
const withThe = (p: string): string => (/^(Sun|Moon|North Node|South Node|Ascendant|Descendant|Midheaven|Part of Fortune|Vertex)$/.test(p) ? `the ${p}` : p)
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const FRACTIONS: Record<string, string> = { '½': 'one half', '⅓': 'one third', '⅔': 'two thirds', '¼': 'one quarter', '¾': 'three quarters' }

/** "20°36'" -> "20 degrees"; the arc-minutes are more than an ear needs. */
const DEGREE = `\\d{1,2}°(?:\\s?\\d{1,2}\\s?['′’]?)?`
/** The same, keeping the degrees and minutes. */
const DEGREE_PARTS = `(\\d{1,2})°(?:\\s?(\\d{1,2})\\s?['′’]?)?`
/** "20°36' Leo" as a longitude round the zodiac. */
const longitude = (deg: string, min: string | undefined, sign: string): number =>
  SIGNS.indexOf(fullSign(sign)) * 30 + Number(deg) + Number(min ?? 0) / 60

export function astroSpeech(text: string): string {
  let s = text
  s = s.replace(/[︎️]/g, '') // text/emoji presentation selectors

  // --- a transit table row, as one sentence -----------------------------------
  // | Jupiter ☐ square Sun | 20°36' Leo ☐ 20°38' Taurus | 9th → 6th | meaning... |
  // Read before the glyphs become names: the model's choice of symbol between
  // the two bodies is anything at all (a Saturn glyph, say), and the aspect
  // comes from the positions instead. The signs may be short (Sco), the
  // houses bare numbers, one or two, or missing.
  s = s.replace(/^[ \t]*\|([^|\n]*)\|([^|\n]*)\|([^\n]*)$/gm, (m, transit: string, position: string, rest: string) => {
    const bodies = new RegExp(
      `^[^A-Za-z]*(?:transiting[ \\t]+)?(${POINT_ANY})(?![A-Za-z])((?:[^A-Za-z]|${ASPECT_WORD}|transiting|your|natal)*?)(?:your[ \\t]+|natal[ \\t]+)?(${POINT_ANY})(?![A-Za-z])[^A-Za-z]*$`, 'i',
    ).exec(transit.trim())
    const where = new RegExp(
      `^[^A-Za-z0-9]*(?:${DEGREE_PARTS})?[ \\t]*(${SIGN_ANY})(?![A-Za-z])(?:[^A-Za-z0-9]|${ASPECT_WORD})*?(?:${DEGREE_PARTS})?[ \\t]*(${SIGN_ANY})(?![A-Za-z])[^A-Za-z0-9]*$`, 'i',
    ).exec(position.trim())
    if (!bodies || !where) return m
    const [, a, between, b] = bodies as unknown as [string, string, string, string]
    const [, degA, minA, signA, degB, minB, signB] = where as unknown as [string, string | undefined, string | undefined, string, string | undefined, string | undefined, string]
    const aspect = (degA && degB ? aspectBetween(longitude(degA, minA, signA), longitude(degB, minB, signB)) : undefined)
      ?? aspectIn(between) ?? aspectIn(transit) ?? aspectIn(position)
    if (!aspect) return m
    // The next cell is the houses, when it is one or two numbers: the transit's, then the natal point's.
    const cells = rest.split('|').map((c) => c.trim())
    const houses = /^(\d{1,2})(?:st|nd|rd|th)?(?:[ \t]*house)?(?:[ \t]*(?:→|->|⟶|➔|➜|to)[ \t]*(\d{1,2})(?:st|nd|rd|th)?(?:[ \t]*house)?)?$/i.exec(cells[0] ?? '')
    if (houses) cells.shift()
    const notes = cells.filter(Boolean).join('. ')
    const from = capitalise(withThe(pointName(a)))
    const to = `your ${pointName(b)} in ${fullSign(signB)}`
    const [, h1, h2] = houses ?? []
    const sentence = h1 && h2 ? `${from} in ${fullSign(signA)}, your ${ordinal(Number(h1))} house, ${aspect.verb} ${to}, in your ${ordinal(Number(h2))} house.`
      : h1 ? `${from} in ${fullSign(signA)} ${aspect.verb} ${to}, in your ${ordinal(Number(h1))} house.`
        : `${from} in ${fullSign(signA)} ${aspect.verb} ${to}.`
    return `${sentence}${notes ? ` ${endSentence(notes)}` : ''}`
  })

  // --- glyphs to names ------------------------------------------------------
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

  // "Moon trine Mercury (27°30' Leo trine 27°30' Aries, house 5)": who's where, then the house.
  s = s.replace(
    new RegExp(`\\b(${POINT})[ \\t]+(${ASPECT_WORD})[ \\t]+(?:your[ \\t]+|natal[ \\t]+)?(${POINT})[ \\t]*\\([ \\t]*(?:${DEGREE})?[ \\t]*(${SIGN})[ \\t]+(?:${ASPECT_WORD})[ \\t]+(?:${DEGREE})?[ \\t]*(${SIGN})(?:,[ \\t]*house[ \\t]+(\\d{1,2}))?[ \\t]*\\)`, 'gi'),
    (_m, a: string, aspect: string, b: string, signA: string, signB: string, house?: string) =>
      `${withThe(a)} in ${signA} ${aspectOf(aspect)?.verb ?? aspect} ${b} in ${signB}${house ? `, in your ${ordinal(Number(house))} house` : ''}`,
  )

  // --- positions -----------------------------------------------------------
  // A sign shortened after a position, "15°35' Sco", in full.
  s = s.replace(new RegExp(`(°(?:\\s?\\d{1,2}\\s?['′’]?)?[ \\t]*)(${SIGN_ANY})(?![A-Za-z])`, 'g'), (_m, pre: string, sign: string) => `${pre}${fullSign(sign)}`)
  // "Sun 13°00′ Libra" -> "Sun in Libra"; a position on its own -> "20 degrees Leo".
  s = s.replace(new RegExp(`\\b(${POINT})[ \\t]+(?:${DEGREE})[ \\t]*(${SIGN})\\b`, 'g'), '$1 in $2')
  s = s.replace(/\b(\d{1,2})°(?:\s?\d{1,2}\s?['′’]?)?/g, (_m, d: string) => `${d} ${d === '1' ? 'degree' : 'degrees'}`)

  // "Jupiter square your Sun" reads better as "Jupiter squaring your Sun" -- unless a verb follows
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
