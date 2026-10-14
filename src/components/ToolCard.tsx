import { useMemo, useState, memo } from 'react'
import { Wrench, ChevronRight, TriangleAlert } from 'lucide-react'
import { argValue, argsSummary, prettyOutput, sizeLabel, toolLabel } from '../lib/toolFormat.ts'
import { looksLikeChart, parseWheel } from '../lib/chartWheel.ts'
import ChartWheel from './ChartWheel'
import { ActiveTransits, UpcomingTransits } from './TransitTable'
import { looksLikeUpcoming, parseUpcoming } from '../lib/transitTable.ts'

interface ToolCardProps {
  name?: string
  /** The MCP server that provided the tool, e.g. "mcp/astrology-v2". */
  plugin?: string
  /** The parameters it was called with. */
  args?: Record<string, unknown>
  output?: string
  failed?: boolean
  /** A transit chart's readings, one per aspect, once the server has written them. */
  readings?: Record<string, string>
}

/** Output this short is shown whole; anything longer collapses to one line. */
const SHORT = 120

/**
 * One tool call. Collapsed, it's a single row -- what ran, from where, how
 * much it returned -- with its parameters on one line and one line of the
 * result; expanded, each parameter in full, then the whole result in its
 * own scrolling panel, JSON indented. A chart from the astrology server is
 * also drawn as a wheel (see ChartWheel), with its transits as a table
 * under it, and a list of upcoming transits as a table (TransitTable),
 * shown either way.
 */
function ToolCard({ name, plugin, args, output, failed, readings }: ToolCardProps) {
  const [open, setOpen] = useState(false)
  const text = output ?? ''
  const short = text.length > 0 && text.length <= SHORT
  const params = args && Object.keys(args).length ? Object.entries(args) : []
  const expandable = text.length > SHORT || params.length > 0
  // Only format what's being shown: results run to tens of kilobytes.
  const full = useMemo(() => (open ? prettyOutput(text) : ''), [open, text])
  // A chart result is drawn as a wheel above its text, whether or not the card is open.
  const wheel = useMemo(() => (!failed && looksLikeChart(text) ? parseWheel(text) : null), [failed, text])
  // And a list of upcoming transits as a table: that result has no wheel.
  const upcoming = useMemo(() => (!failed && looksLikeUpcoming(text) ? parseUpcoming(text) : null), [failed, text])
  const source = plugin?.replace(/^mcp\//, '')
  const meta = [source, text.length > SHORT ? sizeLabel(text.length) : null, failed ? 'failed' : null]
    .filter(Boolean).join(' · ')

  return (
    <div className="msg tool">
      <div className={`tool-card${failed ? ' failed' : ''}${open ? ' open' : ''}`}>
        <button
          type="button"
          className="tool-head"
          onClick={() => expandable && setOpen((v) => !v)}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          title={name}
        >
          <span className="tc-icon" aria-hidden="true">
            {failed ? <TriangleAlert size={14} /> : <Wrench size={14} />}
          </span>
          <span className="tc-title">
            <span className="tc-name">{toolLabel(name)}</span>
            {meta && <span className="tc-meta">{meta}</span>}
          </span>
          {expandable && (
            <span className="tc-chevron" data-open={open || undefined}>
              <ChevronRight size={16} aria-hidden="true" />
            </span>
          )}
        </button>
        {params.length > 0 && !open && <div className="tc-args" title={argsSummary(args!)}>{argsSummary(args!)}</div>}
        {params.length > 0 && open && (
          <dl className="tc-params" aria-label="Parameters">
            {params.map(([k, v]) => (
              <div key={k} className="tc-param">
                <dt>{k}</dt>
                <dd>{argValue(v)}</dd>
              </div>
            ))}
          </dl>
        )}
        {wheel && <ChartWheel wheel={wheel} readings={readings} />}
        {wheel?.kind === 'transit' && <ActiveTransits wheel={wheel} />}
        {upcoming && <UpcomingTransits table={upcoming} />}
        {short && <div className="tc-short">{text}</div>}
        {text.length > SHORT && !open && <div className="tc-preview">{text.replace(/\s+/g, ' ').slice(0, 300)}</div>}
        {text.length > SHORT && open && <pre className="tc-output">{full}</pre>}
      </div>
    </div>
  )
}

// Memoised: during streaming only the final message changes, but every
// message re-rendered -- and for assistant text that meant re-parsing all
// the markdown in the thread on every token.
export default memo(ToolCard)
