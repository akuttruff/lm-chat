import { type Wheel, ordinal } from '../lib/chartWheel.ts'
import { activeTransits, aspectCell, bodyCell, dayOnly, dayText, orbText, windowText } from '../lib/transitTable.ts'
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

/**
 * The transits in play at the wheel's moment, under the wheel: each aspect
 * on it as a row, tightest first, with the natal house it lands in, the
 * orb, and when it is or was exact.
 */
export function ActiveTransits({ wheel }: { wheel: Wheel }) {
  const rows = activeTransits(wheel)
  if (rows.length === 0) return null
  return (
    <div className="tt-wrap">
      <table className="tt">
        <caption>Transits on {wheel.dateTime ? dayText(wheel.dateTime) : 'this day'}</caption>
        <thead>
          <tr><th>Transit</th><th>Aspect</th><th>Natal</th><th>Orb</th><th>Exact</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.from}|${r.type}|${r.to}`}>
              <td><Body name={r.from} retrograde={r.fromRetrograde} /></td>
              <td><Aspect type={r.type} /></td>
              <td><Natal name={r.to} retrograde={r.toRetrograde} house={r.toHouse} /></td>
              <td className="tt-num">{orbText(r.orb)}</td>
              {/* The exact moment says which way it is going; only without one is the word needed. */}
              <td className="tt-when">{r.exact ? dayText(r.exact) : r.movement ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The key transits of a forecast, under the result: the headlines that reach
 * KEY_WEIGHT, in the tool's order, each with when it is exact (or the
 * days it is in orb, dimmed, when it never is within the period), both
 * ends, the natal house, and which pass it is when a retrograde brings it
 * back.
 */
export function ForecastTransits({ table }: { table: ForecastTable }) {
  const rows = keyTransits(table)
  if (rows.length === 0) return null
  const when = table.horizon === 'week' ? dayText : dayOnly
  const passes = rows.some((r) => r.pass)
  return (
    <div className="tt-wrap">
      <table className="tt">
        <caption>Key transits · {periodText(table)}</caption>
        <thead>
          <tr><th>When</th><th>Transit</th><th>Aspect</th><th>Natal</th>{passes && <th>Pass</th>}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.from}|${r.type}|${r.to}|${r.start}|${i}`}>
              <td className="tt-when">
                {r.exact
                  ? when(r.exact)
                  : <span className="tt-house" title={`in orb ${windowText(r.start, r.end)}, not exact in the period`}>{windowText(r.start, r.end)}</span>}
              </td>
              <td><Body name={r.from} retrograde={r.fromRetrograde} /></td>
              <td><Aspect type={r.type} /></td>
              <td><Natal name={r.to} house={r.toHouse} /></td>
              {passes && <td className="tt-num">{r.pass ?? ''}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
