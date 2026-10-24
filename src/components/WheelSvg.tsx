// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  aspectDetail, aspectFamily, aspectSentence, aspectsOfPoint, describePoint, elementOf, fromLongitude, natalLongitude,
  polar, screenAngle, signDegrees, spread, SIGN_GLYPHS, SIGN_NAMES,
  type AspectFamily, type Element as ZodiacElement, type Ring as RingName, type Wheel, type WheelPoint, aspectGlyph, hasRetrograde} from '../lib/chartWheel.ts'
import { readingFor } from '../lib/readings.ts'
import { placeTip, type Placement, type Point, type Subject } from '../lib/tipPlacement.ts'

/**
 * A chart wheel: the zodiac round the outside, the houses, the natal
 * planets, and for a transit chart a second ring of where the planets are
 * now, with the aspects between the two rings drawn across the centre. The
 * Ascendant sits at the left and the signs run counter-clockwise, as
 * charts are printed.
 *
 * The colours are written into the SVG rather than taken from the
 * stylesheet, so the picture saved as a PNG is the one on screen. The card
 * around it (how it opens full size, whether it saves) is each app's own
 * ChartWheel.tsx; this is the picture and its caption.
 */

const SIZE = 600
const C = SIZE / 2
/** The wheel's ground, for a PNG of it. */
export const WHEEL_BACKGROUND = '#1B1D1A'
const PALETTE = {
  bg: WHEEL_BACKGROUND, band: '#23261F', line: '#34372E', paper: '#EDE8DC', dim: '#B9B4A6', faint: '#6B7A64',
  fire: '#D08466', earth: '#8FA382', air: '#D9B86A', water: '#7FA6C9',
  // Aspect lines: brighter than the sign colours, so they read across the centre.
  hard: '#E8906C', soft: '#8FBCE6', conjunction: '#EDE8DC', minor: '#9FB592',
  // The natal ring is in paper; the transit ring a violet nothing else uses, so the two read apart.
  natal: '#EDE8DC', transit: '#C9B4EC', natalDegree: '#B9B4A6', transitDegree: '#A99AC9',
}
const ELEMENT_COLOR: Record<ZodiacElement, string> = {
  fire: PALETTE.fire, earth: PALETTE.earth, air: PALETTE.air, water: PALETTE.water,
}
const ASPECT_COLOR: Record<AspectFamily, string> = {
  conjunction: PALETTE.conjunction, hard: PALETTE.hard, soft: PALETTE.soft, minor: PALETTE.minor,
}
const FONT = '-apple-system, "SF Pro Text", system-ui, "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif'

/** Radii, from the outside in. */
const R_EDGE = 294
const R_ZODIAC = 264
const R_TICKS = 256

interface Band { outer: number; inner: number }

/**
 * Where each ring sits: the transit ring, when there is one, takes the room
 * outside the natal ring. The house numbers sit just inside the aspect
 * circle, as on a printed chart, which keeps that circle -- where the
 * aspects are read -- as large as it can be.
 */
function layout(kind: Wheel['kind']): { outer: Band | null; inner: Band; houses: number; aspects: number } {
  if (kind === 'transit') {
    return { outer: { outer: R_TICKS, inner: 200 }, inner: { outer: 200, inner: 146 }, houses: 134, aspects: 146 }
  }
  return { outer: null, inner: { outer: R_TICKS, inner: 196 }, houses: 184, aspects: 196 }
}

interface Placed extends WheelPoint {
  /** Where the glyph is drawn, after being nudged clear of its neighbours. */
  shown: number
}

/** Glyphs spread so none overlaps, given the radius they're drawn at. */
function place(points: WheelPoint[], glyphRadius: number, glyphSize: number): Placed[] {
  const minGap = ((glyphSize + 4) / glyphRadius) * (180 / Math.PI)
  const shown = spread(points.map((p) => p.longitude), minGap)
  return points.map((p, i) => ({ ...p, shown: shown[i]! }))
}

interface RingProps {
  name: RingName
  points: WheelPoint[]
  band: Band
  asc: number
  glyphSize: number
  /** Glyph and degree colours, one pair per ring. */
  color: string
  degreeColor: string
  /** Whether each glyph has its degree beside it; without, a retrograde one has a small ℞ by it instead. */
  degrees: boolean
  /** A pointer came to, left, or pressed one of this ring's points. */
  onPoint: (ring: RingName, point: WheelPoint, x: number, y: number, e: React.PointerEvent, what: Touch) => void
  /** A click on a point: the card wants to know, so a tap on a planet shows its popup instead of opening the wheel full size. */
  onPointClick: (e: React.MouseEvent) => void
}

type Touch = 'enter' | 'leave' | 'press'

/**
 * One ring of planets: a pointer at each true position, the glyph and its
 * degree beside it. Without degrees the popup gives it, with the sign and
 * house, to a pointer that hovers or a finger that holds.
 */
function Ring({ name, points, band, asc, glyphSize, color, degreeColor, degrees, onPoint, onPointClick }: RingProps) {
  const glyphR = band.outer - 17
  const degreeR = band.outer - 36
  const placed = place(points, glyphR, glyphSize)
  return (
    <g>
      {placed.map((p) => {
        const trueAngle = screenAngle(p.longitude, asc)
        const shownAngle = screenAngle(p.shown, asc)
        const [x1, y1] = polar(C, C, band.outer, trueAngle)
        const [x2, y2] = polar(C, C, band.outer - 6, trueAngle)
        const [gx, gy] = polar(C, C, glyphR, shownAngle)
        const [dx, dy] = polar(C, C, degreeR, shownAngle)
        const { deg, min } = signDegrees(p.longitude)
        return (
          <g
            key={p.name}
            className="wheel-point"
            onPointerEnter={(e) => onPoint(name, p, gx, gy, e, 'enter')}
            onPointerLeave={(e) => onPoint(name, p, gx, gy, e, 'leave')}
            onPointerDown={(e) => onPoint(name, p, gx, gy, e, 'press')}
            onClick={onPointClick}
          >
            <circle cx={gx} cy={gy} r={14} fill="transparent" />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} />
            <text x={gx} y={gy} fontSize={glyphSize} fill={color} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}>
              {p.glyph}
            </text>
            {degrees ? (
              <text x={dx} y={dy} fontSize={11} fill={degreeColor} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}>
                {deg}°<tspan fontSize={8}>{String(min).padStart(2, '0')}</tspan>
                {p.retrograde && <tspan className="wheel-rx" fontSize={9} fill={PALETTE.hard}> ℞</tspan>}
              </text>
            ) : p.retrograde && (
              <text className="wheel-rx" x={gx + glyphSize * 0.5} y={gy - glyphSize * 0.42} fontSize={8} fill={PALETTE.hard} textAnchor="start" dominantBaseline="central" fontFamily={FONT}>℞</text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/**
 * What is under the pointer: a planet on a ring, or one aspect line. From
 * a finger it is `held`: the popup stays up after the finger lifts, until
 * a tap somewhere else, and sits clear of the finger rather than beside it.
 */
type Hover =
  | { kind: 'point'; ring: RingName; point: WheelPoint; x: number; y: number; held: boolean }
  | { kind: 'aspect'; index: number; x: number; y: number; held: boolean }

const sameHover = (a: Hover, b: Hover): boolean =>
  a.kind === 'point' && b.kind === 'point' ? a.ring === b.ring && a.point.name === b.point.name
    : a.kind === 'aspect' && b.kind === 'aspect' ? a.index === b.index : false

/**
 * The popup for what is pointed at, in words: a planet with its position
 * and the aspects it makes, or one aspect -- and, on a transit wheel, the
 * reading written for each aspect (see lib/readings.ts), when it has
 * arrived. Fixed on the page, so it reads the same in the card and in the
 * zoomed viewer, and placed so that it never covers what it describes:
 * outside the wheel where the page has room, else clear of the planet or
 * line itself (see lib/tipPlacement.ts).
 */
function WheelTip({ wheel, hover, svg, readings }: { wheel: Wheel; hover: Hover; svg: SVGSVGElement | null; readings?: Record<string, string> }) {
  const ref = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState<Placement | null>(null)
  const rings = layout(wheel.kind)
  const asc = wheel.angles.Asc

  /** What the popup must keep clear of, in page pixels: the planet, or the aspect line from glyph to glyph. */
  const subject = useMemo((): Subject | null => {
    if (!svg) return null
    const box = svg.getBoundingClientRect()
    const toPage = (x: number, y: number): Point => ({ x: box.left + (x / SIZE) * box.width, y: box.top + (y / SIZE) * box.height })
    if (hover.kind === 'point') return { kind: 'point', at: toPage(hover.x, hover.y) }
    const a = wheel.aspects[hover.index]!
    const from = fromLongitude(wheel, a.from)
    const to = natalLongitude(wheel, a.to)
    if (from === null || to === null) return { kind: 'point', at: toPage(hover.x, hover.y) }
    const [x1, y1] = polar(C, C, (rings.outer ?? rings.inner).outer - 17, screenAngle(from, asc))
    const [x2, y2] = polar(C, C, rings.inner.outer - 17, screenAngle(to, asc))
    return { kind: 'line', from: toPage(x1, y1), to: toPage(x2, y2) }
  }, [hover, svg, wheel, rings, asc])

  // Placed once drawn, from its measured size; again whenever its words or its subject change.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !svg || !subject) return
    const next = placeTip(
      subject, { width: el.offsetWidth, height: el.offsetHeight }, svg.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight }, hover.held,
    )
    setSpot((cur) => (cur && cur.left === next.left && cur.top === next.top && cur.side === next.side ? cur : next))
  }, [subject, svg, hover, wheel, readings])

  if (!svg || typeof document === 'undefined') return null
  let body: React.ReactNode
  /** With a reading to show, the popup takes a paragraph's width. */
  let wide: boolean
  if (hover.kind === 'point') {
    const d = describePoint(wheel, hover.ring, hover.point)
    const indexes = aspectsOfPoint(wheel, hover.ring, hover.point.name)
    // Each aspect with its reading -- unless there are many, when the sentences alone keep the popup a popup.
    const withReadings = indexes.length <= 3
    const lines = indexes.map((i) => {
      const a = wheel.aspects[i]!
      return { glyph: aspectGlyph(a.type), sentence: aspectSentence(wheel, a), reading: withReadings ? readingFor(readings, a) : null }
    })
    wide = lines.some((line) => line.reading !== null)
    body = (
      <>
        <div className="wheel-tip-title">{d.title}</div>
        <div className="wheel-tip-sub">{d.position}</div>
        {lines.length > 0
          ? (
            <ul>
              {lines.map((line) => (
                <li key={line.sentence}>
                  {line.glyph && <span className="wheel-glyph" aria-hidden="true">{line.glyph}</span>}
                  {line.sentence}
                  {line.reading && <p className="wheel-tip-reading">{line.reading}</p>}
                </li>
              ))}
            </ul>
          )
          : <div className="wheel-tip-sub">{wheel.kind === 'transit' && hover.ring === 'outer' ? 'No aspects to your chart right now' : 'No aspects'}</div>}
      </>
    )
  } else {
    const a = wheel.aspects[hover.index]!
    const reading = readingFor(readings, a)
    wide = reading !== null
    body = (
      <>
        <div className="wheel-tip-title">
          {aspectGlyph(a.type) && <span className="wheel-glyph" aria-hidden="true">{aspectGlyph(a.type)}</span>}
          {aspectSentence(wheel, a)}
        </div>
        <div className="wheel-tip-sub">{aspectDetail(a)}</div>
        {reading
          ? <p className="wheel-tip-reading">{reading}</p>
          : wheel.kind === 'transit' && !readings && <p className="wheel-tip-reading pending">A reading for this transit is on its way.</p>}
      </>
    )
  }
  const style: React.CSSProperties = spot
    ? { left: spot.left, top: spot.top, width: wide ? 300 : undefined, maxWidth: wide ? 300 : 280 }
    : { left: 0, top: 0, width: wide ? 300 : undefined, maxWidth: wide ? 300 : 280, visibility: 'hidden' }
  return createPortal(
    <div ref={ref} className={`wheel-tip ${spot?.side ?? 'placing'}`} role="tooltip" style={style}>{body}</div>,
    document.body,
  )
}

interface WheelSvgProps {
  wheel: Wheel
  title: string
  readings?: Record<string, string>
  /** Told the drawn element, for a PNG of it. */
  onSvg?: (el: SVGSVGElement | null) => void
  /** Each planet's degree beside its glyph, as by default; false leaves it to the popup. */
  degrees?: boolean
}

/** The picture itself; drawn in the card, and again full size. */
export function WheelSvg({ wheel, title, readings, onSvg, degrees = true }: WheelSvgProps) {
  const asc = wheel.angles.Asc
  const rings = layout(wheel.kind)
  // The element itself, as state: the popup measures against it, and a ref read during render is not allowed.
  const [own, setOwn] = useState<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const setRef = useCallback((el: SVGSVGElement | null) => {
    setOwn(el)
    onSvg?.(el)
  }, [onSvg])
  /** The last press came from a finger: the click that follows must not open the wheel full size. */
  const pressedByTouch = useRef(false)
  /** Comes to, leaves or presses something: a mouse hovers, a finger holds. */
  const touch = (next: Hover, e: React.PointerEvent, what: Touch) => {
    const finger = e.pointerType !== 'mouse'
    if (what === 'press') {
      if (!finger) return
      pressedByTouch.current = true
      setHover((cur) => (cur?.held && sameHover(cur, next) ? null : { ...next, held: true }))
    } else if (!finger) {
      setHover(what === 'enter' ? next : (cur) => (cur?.held ? cur : null))
    }
  }
  const onPoint = (ring: RingName, point: WheelPoint, x: number, y: number, e: React.PointerEvent, what: Touch) =>
    touch({ kind: 'point', ring, point, x, y, held: false }, e, what)
  const onPointClick = (e: React.MouseEvent) => {
    if (pressedByTouch.current) { e.stopPropagation(); e.preventDefault() }
    pressedByTouch.current = false
  }
  /** A finger on the wheel's empty parts lets a held popup go. */
  const onSvgPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return
    if ((e.target as Element).closest?.('.wheel-point, .wheel-aspect')) return
    setHover((cur) => (cur?.held ? null : cur))
  }
  /** Which aspect lines light up: the pointed-at one, or every one the pointed-at planet makes. */
  const lit = useMemo(() => {
    if (!hover) return null
    return new Set(hover.kind === 'aspect' ? [hover.index] : aspectsOfPoint(wheel, hover.ring, hover.point.name))
  }, [hover, wheel])

  // The degree ticks never change for a given Ascendant; a hover shouldn't redraw all 360.
  const ticks = useMemo(() => {
    const out: React.ReactNode[] = []
    for (let d = 0; d < 360; d++) {
      const len = d % 10 === 0 ? 8 : d % 5 === 0 ? 5 : 2.5
      const a = screenAngle(d, asc)
      const [x1, y1] = polar(C, C, R_ZODIAC, a)
      const [x2, y2] = polar(C, C, R_ZODIAC - len, a)
      out.push(<line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke={PALETTE.dim} strokeWidth={d % 10 === 0 ? 1 : 0.6} />)
    }
    return out
  }, [asc])

  return (
    <>
      {hover && <WheelTip wheel={wheel} hover={hover} svg={own} readings={readings} />}
      <svg
        ref={setRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={title}
        className="wheel-svg"
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover((cur) => (cur?.held ? cur : null)) }}
        onPointerDown={onSvgPointerDown}
      >
        <rect width={SIZE} height={SIZE} fill={PALETTE.bg} />
        {/* The zodiac band. */}
        <circle cx={C} cy={C} r={R_EDGE} fill={PALETTE.band} stroke={PALETTE.line} />
        <circle cx={C} cy={C} r={R_ZODIAC} fill={PALETTE.bg} stroke={PALETTE.line} />
        {SIGN_NAMES.map((name, i) => {
          const start = screenAngle(i * 30, asc)
          const [x1, y1] = polar(C, C, R_ZODIAC, start)
          const [x2, y2] = polar(C, C, R_EDGE, start)
          const [gx, gy] = polar(C, C, (R_EDGE + R_ZODIAC) / 2, screenAngle(i * 30 + 15, asc))
          return (
            <g key={name}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={PALETTE.line} />
              <text x={gx} y={gy} fontSize={20} fill={ELEMENT_COLOR[elementOf(i)]} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}>
                <title>{name}</title>
                {SIGN_GLYPHS[i]}
              </text>
            </g>
          )
        })}
        {ticks}
        <circle cx={C} cy={C} r={R_TICKS} fill="none" stroke={PALETTE.line} />

        {/* Ring boundaries and the house cusps. */}
        {rings.outer && <circle cx={C} cy={C} r={rings.outer.inner} fill="none" stroke={PALETTE.line} />}
        <circle cx={C} cy={C} r={rings.inner.inner} fill="none" stroke={PALETTE.line} />
        <circle cx={C} cy={C} r={rings.aspects} fill="none" stroke={PALETTE.line} />
        {wheel.cusps.map((cusp, i) => {
          const a = screenAngle(cusp, asc)
          const [x1, y1] = polar(C, C, rings.aspects, a)
          const [x2, y2] = polar(C, C, R_ZODIAC, a)
          // The number sits just inside the cusp, as on a printed chart, where
          // the Midheaven (often mid-house) can't run through it.
          const [nx, ny] = polar(C, C, rings.houses, screenAngle(cusp + 5, asc))
          return (
            <g key={i}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={PALETTE.line} />
              <text x={nx} y={ny} fontSize={11} fill={PALETTE.faint} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}>{i + 1}</text>
            </g>
          )
        })}

        {/* The angles: Ascendant and Midheaven drawn through, their opposites lightly. */}
        {(['Asc', 'MC', 'Desc', 'IC'] as const).map((name) => {
          const lon = natalLongitude(wheel, name)
          if (lon === null) return null
          const main = name === 'Asc' || name === 'MC'
          const a = screenAngle(lon, asc)
          const [x1, y1] = polar(C, C, rings.aspects, a)
          const [x2, y2] = polar(C, C, R_ZODIAC, a)
          // Deeper in than the house numbers, so the two never sit on each other.
          const [lx, ly] = polar(C, C, rings.aspects - 28, a)
          const label = { Asc: 'AC', MC: 'MC', Desc: 'DC', IC: 'IC' }[name]
          return (
            <g key={name}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={main ? PALETTE.paper : PALETTE.dim} strokeWidth={main ? 2 : 0.9} strokeDasharray={main ? undefined : '3 3'} />
              <text x={lx} y={ly} fontSize={main ? 12 : 10} fontWeight={main ? 600 : 400} fill={main ? PALETTE.paper : PALETTE.dim} textAnchor="middle" dominantBaseline="central" fontFamily={FONT}>{label}</text>
            </g>
          )
        })}

        {/* Aspect lines across the centre. */}
        {wheel.aspects.map((asp, i) => {
          const from = fromLongitude(wheel, asp.from)
          const to = natalLongitude(wheel, asp.to)
          if (from === null || to === null) return null
          const [x1, y1] = polar(C, C, rings.aspects, screenAngle(from, asc))
          const [x2, y2] = polar(C, C, rings.aspects, screenAngle(to, asc))
          const family = aspectFamily(asp.type)
          const color = ASPECT_COLOR[family]
          // Tighter orbs draw heavier; nothing thinner than reads on a phone.
          const isLit = lit?.has(i) ?? false
          const width = Math.max(1.5, 3 - asp.orb * 0.5) + (isLit ? 1.5 : 0)
          const opacity = lit && !isLit ? 0.18 : family === 'conjunction' ? 0.75 : 1
          const [mx, my] = [(x1 + x2) / 2, (y1 + y2) / 2]
          return (
            <g
              key={i}
              className="wheel-aspect"
              opacity={opacity}
              onPointerEnter={(e) => touch({ kind: 'aspect', index: i, x: mx, y: my, held: false }, e, 'enter')}
              onPointerLeave={(e) => touch({ kind: 'aspect', index: i, x: mx, y: my, held: false }, e, 'leave')}
              onPointerDown={(e) => touch({ kind: 'aspect', index: i, x: mx, y: my, held: false }, e, 'press')}
              onClick={onPointClick}
            >
              {/* A wide invisible stroke, so the line is easy to point at. */}
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={14} />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} strokeDasharray={family === 'minor' ? '5 4' : undefined} />
              <circle cx={x1} cy={y1} r={isLit ? 4.5 : 3} fill={color} />
              <circle cx={x2} cy={y2} r={isLit ? 4.5 : 3} fill={color} />
            </g>
          )
        })}

        {rings.outer && (
          <Ring
            name="outer" points={wheel.outer} band={rings.outer} asc={asc} glyphSize={18}
            color={PALETTE.transit} degreeColor={PALETTE.transitDegree} degrees={degrees} onPoint={onPoint} onPointClick={onPointClick}
          />
        )}
        <Ring
          name="inner" points={wheel.inner} band={rings.inner} asc={asc} glyphSize={wheel.kind === 'transit' ? 17 : 19}
          color={PALETTE.natal} degreeColor={PALETTE.natalDegree} degrees={degrees} onPoint={onPoint} onPointClick={onPointClick}
        />
      </svg>
    </>
  )
}

/** The wheel's title and its legend, under the picture; `children` (a save button, say) at the end. */
export function WheelCaption({ wheel, title, children }: { wheel: Wheel; title: string; children?: ReactNode }) {
  return (
    <figcaption className="wheel-caption">
      <span className="wheel-title">{title}</span>
      <span className="wheel-legend" aria-hidden="true">
        {wheel.kind === 'transit' && (
          <>
            <b style={{ color: PALETTE.transit }}>●</b> transits
            <b style={{ color: PALETTE.natal }}>●</b> natal
          </>
        )}
        <i style={{ background: ASPECT_COLOR.hard }} /> {aspectGlyph('square')} square, {aspectGlyph('opposition')} opposition
        <i style={{ background: ASPECT_COLOR.soft }} /> {aspectGlyph('trine')} trine, {aspectGlyph('sextile')} sextile
        <i style={{ background: ASPECT_COLOR.conjunction }} /> {aspectGlyph('conjunction')} conjunction
        {hasRetrograde(wheel) && <><b style={{ color: PALETTE.hard }}>℞</b> retrograde</>}
      </span>
      {children}
    </figcaption>
  )
}
