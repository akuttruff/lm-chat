import { type Wheel, ordinal } from '../lib/chartWheel.ts'
import { type TransitRow, type UpcomingTable, activeTransits, aspectCell, bodyCell, dayText, orbText, windowText } from '../lib/transitTable.ts'

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

function Natal({ row, natal }: { row: TransitRow; natal: boolean }) {
  return (
    <>
      <Body name={row.to} retrograde={row.toRetrograde} />
      {natal && row.toHouse !== null && <span className="tt-house"> · {ordinal(row.toHouse)}</span>}
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
              <td><Natal row={r} natal /></td>
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
 * The spans of a list_upcoming_transits result as a table: the days each
 * contact is in orb, both ends, and the moment it is exact. Without a birth
 * chart the second body is just the other end, not a natal point.
 */
export function UpcomingTransits({ table }: { table: UpcomingTable }) {
  const natal = table.mode === 'natal'
  return (
    <div className="tt-wrap">
      <table className="tt">
        <caption>Transits {windowText(table.start, table.end)}{table.rows.length === 0 ? ': none in orb' : ''}</caption>
        {table.rows.length > 0 && (
          <>
            <thead>
              <tr><th>When</th><th>Transit</th><th>Aspect</th><th>{natal ? 'Natal' : 'To'}</th><th>Exact</th></tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={`${r.from}|${r.type}|${r.to}|${r.start}|${i}`}>
                  <td className="tt-when">{windowText(r.start, r.end)}</td>
                  <td><Body name={r.from} retrograde={r.fromRetrograde} /></td>
                  <td><Aspect type={r.type} /></td>
                  <td><Natal row={r} natal={natal} /></td>
                  <td className="tt-when">{r.exact ? dayText(r.exact) : <span className="tt-house" title={`tightest orb ${orbText(r.orb)}`}>orb {orbText(r.orb)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </>
        )}
      </table>
      {table.omitted && <p className="tt-note">{table.omitted}</p>}
    </div>
  )
}
