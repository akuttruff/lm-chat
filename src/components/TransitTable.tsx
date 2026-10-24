// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { type Wheel, displayName, ordinal } from '../lib/chartWheel.ts'
import { activeTransits, aspectCell, bodyCell, dayParts, dayText, orbText, windowText } from '../lib/transitTable.ts'
import { type ForecastRow, type ForecastTable, keyTransits, periodText, scanGroups } from '../lib/forecastTable.ts'
import { nextSort, sortRows, type Sort, type SortKey, type Sortable } from '../lib/sortRows.ts'
import { ASPECT_WEIGHT, MAX_WEIGHT, SLOWNESS, weightParts, weightText } from '../lib/weight.ts'

/** The columns, the last only with weights; sortable, a click sorts up, another down, a third goes back to the table's own order. */
const COLUMNS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'when', label: 'When', hint: 'by the moment it is exact' },
  { key: 'from', label: 'Transit', hint: 'by the transiting body' },
  { key: 'orb', label: 'Aspect', hint: 'by how close the orb is' },
  { key: 'to', label: 'Natal', hint: 'by the natal point' },
  { key: 'weight', label: 'Weight', hint: 'by how much it shapes the period' },
]

/**
 * What a table shows beyond its four plain columns, both off unless asked
 * for: `weights`, a Weight column with each row's working; `sortable`,
 * headers that sort the rows.
 */
export interface TableOptions { weights?: boolean; sortable?: boolean }

const columnsFor = (weights: boolean) => (weights ? COLUMNS : COLUMNS.filter((c) => c.key !== 'weight'))

function Head({ sort, onSort, weights, sortable }: { sort: Sort | null; onSort: (key: SortKey) => void; weights: boolean; sortable: boolean }) {
  const columns = columnsFor(weights)
  if (!sortable) return <thead><tr>{columns.map(({ key, label }) => <th key={key}>{label}</th>)}</tr></thead>
  return (
    <thead>
      <tr>
        {columns.map(({ key, label, hint }) => {
          const on = sort?.key === key ? sort.dir : null
          return (
            <th key={key} aria-sort={on === 'asc' ? 'ascending' : on === 'desc' ? 'descending' : 'none'} className={key === 'weight' ? 'tt-th-help' : undefined}>
              <button
                type="button"
                className={`tt-sort${on ? ' on' : ''}`}
                title={key === 'weight' ? undefined : `Sort ${hint}`}
                aria-describedby={key === 'weight' ? 'tt-weight-help' : undefined}
                onClick={() => onSort(key)}
              >
                {label}
                {on === 'asc' && <ArrowUp size={11} aria-label="ascending" />}
                {on === 'desc' && <ArrowDown size={11} aria-label="descending" />}
              </button>
              {key === 'weight' && <WeightHelp />}
            </th>
          )
        })}
      </tr>
    </thead>
  )
}

/** The rows in the chosen order, with the header to choose it and a way back to the table's own order. */
function useSorted<T extends Sortable>(rows: T[]): { rows: T[]; sort: Sort | null; onSort: (key: SortKey) => void; reset: () => void } {
  const [sort, setSort] = useState<Sort | null>(null)
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort])
  return { rows: sorted, sort, onSort: (key) => setSort((cur) => nextSort(cur, key)), reset: () => setSort(null) }
}

function Caption({ text, sort, onReset }: { text: string; sort: Sort | null; onReset: () => void }) {
  return (
    <caption>
      {text}
      {sort && <> · <button type="button" className="link tt-reset" onClick={onReset}>default order</button></>}
    </caption>
  )
}

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

/** "Mercury 0.5 · Venus 0.7 · …": a scale's numbers in a line. */
const scaleText = (scale: Record<string, number>): string => Object.entries(scale).map(([name, n]) => `${displayName(name)} ${n}`).join(' · ')

/** How the Weight column is worked out, in a popup over its header on a pointer; a phone goes without. */
function WeightHelp() {
  return (
    <div className="tt-help" role="tooltip" id="tt-weight-help">
      <div className="wheel-tip-title">How weight is calculated</div>
      <p className="tt-formula">weight = slowness × aspect, doubled on a key point</p>
      <dl className="tt-scale">
        <dt>Slowness</dt>
        <dd>The transiting planet: the slower it moves, the rarer and longer the transit. {scaleText(SLOWNESS)}.</dd>
        <dt>Aspect</dt>
        <dd>{scaleText(ASPECT_WEIGHT)}.</dd>
        <dt>Key point</dt>
        <dd>×2 when the natal point is the Sun, Moon, Ascendant, MC or the chart ruler (the ruler of the rising sign).</dd>
      </dl>
      <p className="wheel-tip-sub">So Jupiter square the Sun is 3 × 0.9 × 2 = 5.4, and Pluto on the Sun is the most, 10, filling the bar. Click to sort by it.</p>
    </div>
  )
}

/** One row's own working: "Jupiter 3 × square 0.9 × 2 on the Sun = 5.4". */
function Working({ from, to, type, ruler, weight }: { from: string; to: string; type: string; ruler: string | null; weight: number }) {
  const p = weightParts(from, to, type, ruler, ruler === null ? weight : null)
  if (!p) return null
  return (
    <div className="tt-help tt-working" role="tooltip">
      {displayName(from)} {p.slowness} × {type.toLowerCase()} {p.aspect}
      {p.doubled && <> × 2 on {p.doubled === 'chart ruler' ? 'the chart ruler' : `the ${displayName(p.doubled)}`}</>}
      {' '}= {weightText(p.weight)}
    </div>
  )
}

/**
 * How much the transit weighs, as the number over a bar of it: the slower
 * the planet and the more central the natal point, the longer the bar.
 */
function Weight({ weight, from, to, type, ruler }: { weight: number | null; from: string; to: string; type: string; ruler: string | null }) {
  if (weight === null) return <td className="tt-num"><span className="tt-house" title="not on the scale: a point or an aspect the forecasts never rank">—</span></td>
  const share = Math.min(1, weight / MAX_WEIGHT)
  return (
    <td className="tt-num tt-weight tt-th-help">
      {weightText(weight)}
      <div className="tt-bar" aria-hidden="true"><div className="tt-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} /></div>
      <Working from={from} to={to} type={type} ruler={ruler} weight={weight} />
    </td>
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
 * natal house, the aspect over its orb, and (with weights) its weight.
 */
export function ActiveTransits({ wheel, weights = false, sortable = false }: { wheel: Wheel } & TableOptions) {
  const all = useMemo(() => activeTransits(wheel), [wheel])
  const { rows, sort, onSort, reset } = useSorted(all)
  if (rows.length === 0) return null
  return (
    <div className="tt-wrap">
      <table className="tt">
        <Caption text={`Transits on ${wheel.dateTime ? dayText(wheel.dateTime) : 'this day'}`} sort={sort} onReset={reset} />
        <Head sort={sort} onSort={onSort} weights={weights} sortable={sortable} />
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
              {weights && <Weight weight={r.weight} from={r.from} to={r.to} type={r.type} ruler={r.ruler} />}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One forecast contact as a row. */
function ForecastRowView({ r, table, weights }: { r: ForecastRow; table: ForecastTable; weights: boolean }) {
  return (
    <tr>
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
      {weights && <Weight weight={r.weight} from={r.from} to={r.to} type={r.type} ruler={table.ruler} />}
    </tr>
  )
}

const rowKey = (r: ForecastRow, i: number): string => `${r.from}|${r.type}|${r.to}|${r.start}|${i}`

/** How much of a backdrop shows before the rest is asked for. */
export const BACKDROP_SHOWN = 4

/**
 * The transits of a forecast, under the result. For a year, or a period
 * cast without its scan, the headlines that reach KEY_WEIGHT in date
 * order. For a week or a month with a scan, every contact in orb, in two
 * groups: the period's events, exact inside it in date order, then its
 * backdrop, in orb without perfecting, heaviest first and folded past the
 * first few. A sort, when the table is sortable, runs over all the rows
 * at once; the table's own order brings the groups back.
 *
 * Four columns, each with a dim second line so the table fits a phone:
 * the moment it is exact over the days it is in orb (when it never
 * perfects within the period, the nearest exact moment before or after
 * it and whether it is applying or separating), each body over its
 * position, and the aspect over its orb and, when a retrograde brings the
 * contact back, which pass this is. With weights, a fifth: the weight.
 */
export function ForecastTransits({ table, weights = false, sortable = false }: { table: ForecastTable } & TableOptions) {
  const all = useMemo(() => keyTransits(table), [table])
  const groups = useMemo(() => scanGroups(table), [table])
  const { rows, sort, onSort, reset } = useSorted(all)
  const [unfolded, setUnfolded] = useState(false)
  if (rows.length === 0) return null
  const caption = groups ? `Transits in orb · ${periodText(table)}` : `Key transits · ${periodText(table)}`
  if (!groups || sort) {
    return (
      <div className="tt-wrap">
        <table className="tt">
          <Caption text={caption} sort={sort} onReset={reset} />
          <Head sort={sort} onSort={onSort} weights={weights} sortable={sortable} />
          <tbody>{rows.map((r, i) => <ForecastRowView key={rowKey(r, i)} r={r} table={table} weights={weights} />)}</tbody>
        </table>
      </div>
    )
  }
  const hidden = unfolded ? 0 : Math.max(0, groups.backdrop.length - BACKDROP_SHOWN)
  const backdrop = hidden ? groups.backdrop.slice(0, BACKDROP_SHOWN) : groups.backdrop
  const period = table.horizon === 'month' ? 'month' : 'week'
  const span = columnsFor(weights).length
  return (
    <div className="tt-wrap">
      <table className="tt">
        <Caption text={caption} sort={sort} onReset={reset} />
        <Head sort={sort} onSort={onSort} weights={weights} sortable={sortable} />
        {groups.events.length > 0 && (
          <tbody>
            <tr className="tt-group"><th colSpan={span} scope="rowgroup">Exact this {period} · {groups.events.length}</th></tr>
            {groups.events.map((r, i) => <ForecastRowView key={rowKey(r, i)} r={r} table={table} weights={weights} />)}
          </tbody>
        )}
        {groups.backdrop.length > 0 && (
          <tbody>
            <tr className="tt-group"><th colSpan={span} scope="rowgroup">In orb all {period}, not exact in it · {groups.backdrop.length}</th></tr>
            {backdrop.map((r, i) => <ForecastRowView key={rowKey(r, i)} r={r} table={table} weights={weights} />)}
            {hidden > 0 && (
              <tr className="tt-more"><td colSpan={span}><button type="button" className="link" onClick={() => setUnfolded(true)}>Show {hidden} more</button></td></tr>
            )}
          </tbody>
        )}
      </table>
    </div>
  )
}
