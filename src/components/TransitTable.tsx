import { type Wheel, ordinal } from '../lib/chartWheel.ts'
import { activeTransits, aspectCell, bodyCell, dayParts, dayText, orbText, windowText } from '../lib/transitTable.ts'
import { type ForecastTable, keyTransits, periodText } from '../lib/forecastTable.ts'

function Body({ name, retrograde }: { name: string; retrograde: boolean }) {
  const cell = bodyCell(name, retrograde)
  return (
    <span className="tt-body">
      {cell.glyph && <span className="tt-glyph" aria-hidden="true">{cell.glyph}</span>}
      {cell.name}
      {retrograde && <span className="wheel-rx" title="retrograde"> ℞</span>}
    </span>
  )
}

function Aspect({ type }: { type: string }) {
  const cell = aspectCell(type)
  return (
    <span className={`tt-aspect tt-${cell.family}`}>
      {cell.glyph && <span className="tt-glyph" aria-hidden="true">{cell.glyph}</span>}
      {cell.name}
    </span>
  )
}

function Natal({ name, retrograde = false, house }: { name: string; retrograde?: boolean; house: number | null }) {
  return (
    <>
      <Body name={name} retrograde={retrograde} />
      {house !== null && <span className="tt-house"> · {ordinal(house)}</span>}
    </>
  )
}

/** "Oct 6 16:36" on top; dim when it has passed. Over the movement, or the days in orb. */
/** A moment as "Dec 7, 2025 16:36", breakable only between the day and the time. */
function Day({ iso, on }: { iso: string; on: string | null }) {
  const { day, time } = dayParts(iso, on)
  return <>{<span className="tt-date">{day}</span>}{time && <> <span className="tt-date">{time}</span></>}</>
}

function When({ exact, past, nearest, under, on, pass, passes }: {
  exact: string | null; past: boolean; nearest?: string | null; under: string | null; on: string | null; pass: string | null; passes: string[]
}) {
  const shown = exact ?? nearest ?? null
  return (
    <td className="tt-when">
      {exact
        ? <span className={past ? 'tt-near' : 'tt-exact'}>{past ? 'was exact ' : 'exact '}<Day iso={exact} on={on} /></span>
        : nearest
          ? <span className="tt-near" title="in orb through these days; the nearest moment it is exact">{past ? 'was exact ' : 'exact '}<Day iso={nearest} on={on} /></span>
          : <span className="tt-house" title="in orb, not exact within reach of the search">—</span>}
      {under && <div className="tt-pos">{under}</div>}
      {pass && <Run pass={pass} others={passes.filter((p) => p !== shown)} on={on} />}
    </td>
  )
}

/** "pass 1 of 3 · also Feb 21, 2027 · Jun 2, 2027": the rest of a retrograde's run, so one date is never taken for the end of it. */
function Run({ pass, others, on }: { pass: string; others: string[]; on: string | null }) {
  return (
    <div className="tt-pos" title="every moment this contact is exact as the planet retrogrades over it">
      pass {pass}
      {others.map((p, i) => <span key={p}>{i === 0 ? ' · also ' : ' · '}<span className="tt-date">{dayText(p.slice(0, 10), on)}</span></span>)}
    </div>
  )
}

/**
 * The transits in play at the wheel's moment, under the wheel: each aspect
 * on it as a row in date order of its exact moment, past ones dimmed, with
 * whether it is applying or separating, each body over its position, the
 * natal house, and the aspect over its orb.
 */
export function ActiveTransits({ wheel }: { wheel: Wheel }) {
  const rows = activeTransits(wheel)
  if (rows.length === 0) return null
  return (
    <div className="tt-wrap">
      <table className="tt">
        <caption>Transits on {wheel.dateTime ? dayText(wheel.dateTime) : 'this day'}</caption>
        <thead>
          <tr><th>When</th><th>Transit</th><th>Aspect</th><th>Natal</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.from}|${r.type}|${r.to}`}>
              <When exact={r.exact} past={Boolean(r.exact && wheel.dateTime && r.exact < wheel.dateTime)} under={r.movement} on={wheel.dateTime ?? null} pass={r.pass} passes={r.passes} />
              <td>
                <Body name={r.from} retrograde={r.fromRetrograde} />
                {r.fromPosition && <div className="tt-pos">{r.fromPosition}</div>}
              </td>
              <td>
                <Aspect type={r.type} />
                <div className="tt-pos">orb {orbText(r.orb)}</div>
              </td>
              <td>
                <Natal name={r.to} retrograde={r.toRetrograde} house={r.toHouse} />
                {r.toPosition && <div className="tt-pos">{r.toPosition}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The key transits of a forecast, under the result: the headlines that reach
 * KEY_WEIGHT in date order. Four columns, each with a dim second line so the
 * table fits a phone: the moment it is exact over the days it is in orb
 * (when it never perfects within the period, the nearest exact moment
 * before or after it and whether it is applying or separating), each body
 * over its position, and the aspect over its orb and, when a retrograde
 * brings the contact back, which pass this is.
 */
export function ForecastTransits({ table }: { table: ForecastTable }) {
  const rows = keyTransits(table)
  if (rows.length === 0) return null
  return (
    <div className="tt-wrap">
      <table className="tt">
        <caption>Key transits · {periodText(table)}</caption>
        <thead>
          <tr><th>When</th><th>Transit</th><th>Aspect</th><th>Natal</th></tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.from}|${r.type}|${r.to}|${r.start}|${i}`}>
              <When
                exact={r.exact}
                past={Boolean(!r.exact && r.nearestExact && r.nearestExact < r.start)}
                nearest={r.nearestExact}
                on={table.start}
                pass={r.pass}
                passes={r.passes}
                under={`in orb ${windowText(r.start, r.end)}${r.movement ? ` · ${r.movement}` : ''}`}
              />
              <td>
                <Body name={r.from} retrograde={r.fromRetrograde} />
                {r.fromPosition && <div className="tt-pos">{r.fromPosition}</div>}
              </td>
              <td>
                <Aspect type={r.type} />
                <div className="tt-pos">orb {orbText(r.orb)}</div>
              </td>
              <td>
                <Natal name={r.to} house={r.toHouse} />
                {r.toPosition && <div className="tt-pos">{r.toPosition}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
