import zlib from 'node:zlib'
import type { BlockContent, DefinitionContent, List, PhrasingContent, Root, RootContent, Table } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/**
 * Office files written directly: a spreadsheet from CSV, a Word document
 * from Markdown. Both are a few XML parts in a zip. Only what a reply uses
 * is covered -- headings, paragraphs, emphasis, links, lists, task lists,
 * tables, quotes, code -- which is also what macOS's own Word converter
 * gets wrong (it drops tables and list bullets).
 */

/** Text for XML. XML 1.0 has no place for most control characters; a stray one makes Word or Excel refuse the whole file. */
export const xmlText = (s: string): string =>
  // oxlint-disable-next-line no-control-regex -- removing them is the point
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

// --- spreadsheets -------------------------------------------------------

/** CSV or TSV rows; quoted cells may hold the separator, quotes ("") and line breaks. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c !== '"') cell += c
      else if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
    } else if (c === '"' && cell === '') quoted = true
    else if (c === sep) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  // Blank rows inside stay -- a formula's row numbers count them -- but not trailing ones.
  while (rows.length && !rows.at(-1)!.some((v) => v.trim())) rows.pop()
  return rows
}

/** "A", "Z", "AA": a spreadsheet column's letters. */
export function columnName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Cell styles, by index in styles.xml's cellXfs. */
const STYLE = { plain: 0, header: 1, currency: 2, percent: 3, percentDecimal: 4, thousands: 5, thousandsDecimal: 6 } as const

export type Cell =
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: string; style: number }
  | { kind: 'formula'; formula: string }

/**
 * What a CSV cell holds, as a spreadsheet sees it: "$1,200.50" is a number
 * shown as dollars, "15%" is 0.15 shown as a percentage, "=SUM(B2:B9)" a
 * formula. "007" and "A1" stay text, as do phone-number-like strings.
 */
export function readCell(raw: string): Cell {
  const v = raw.trim()
  // A formula, unless it reaches outside the sheet (DDE: =cmd|' /c ...).
  if (/^=[^|]+$/.test(v) && v.length > 1) return { kind: 'formula', formula: v.slice(1) }
  const plain = /^-?(0|[1-9]\d*)(\.\d+)?$/
  const grouped = /^-?[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/
  const money = /^(-?)\$(-?)([\d,]+(?:\.\d+)?)$/.exec(v) ?? /^\((\$)()([\d,]+(?:\.\d+)?)\)$/.exec(v)
  if (money) {
    const digits = money[3]!
    if (plain.test(digits) || grouped.test(digits)) {
      const negative = money[1] === '-' || money[2] === '-' || v.startsWith('(')
      return { kind: 'number', value: `${negative ? '-' : ''}${digits.replace(/,/g, '')}`, style: STYLE.currency }
    }
  }
  const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(v)
  if (percent) {
    const n = percent[1]!
    // Rounded back to the digits given: 14.3 / 100 is 0.14300000000000002 in floating point.
    const value = String(Number((Number(n) / 100).toPrecision(12)))
    return { kind: 'number', value, style: n.includes('.') ? STYLE.percentDecimal : STYLE.percent }
  }
  if (grouped.test(v)) return { kind: 'number', value: v.replace(/,/g, ''), style: v.includes('.') ? STYLE.thousandsDecimal : STYLE.thousands }
  if (plain.test(v)) return { kind: 'number', value: v, style: STYLE.plain }
  return { kind: 'text', text: raw }
}

/**
 * Rows evened out against the header. A model writing CSV by hand often
 * leaves a comma unquoted: inside an amount ("$4,500.00", split into "$4"
 * and "500.00") or in a last "Notes" cell ("Electric, water, internet"),
 * so the row runs past the header. Split amounts are joined back first,
 * then anything still over goes back into the last column, comma and all.
 */
export function evenRows(rows: string[][]): string[][] {
  const width = rows[0]?.length ?? 0
  if (width < 2) return rows
  return rows.map((input) => {
    if (input.length <= width) return input
    let extra = input.length - width
    const row: string[] = []
    for (const cell of input) {
      const prev = row.at(-1)
      if (extra > 0 && prev !== undefined && /^\s*-?\$?-?\d{1,3}(,\d{3})*$/.test(prev) && /^\d{3}(\.\d+)?\s*$/.test(cell)) {
        row[row.length - 1] = `${prev},${cell}`
        extra--
      } else row.push(cell)
    }
    return row.length > width ? [...row.slice(0, width - 1), row.slice(width - 1).join(',')] : row
  })
}

/** "B12" -> [row 11, column 1]; "$B$12" too. */
function refAt(ref: string): [number, number] {
  const m = /^\$?([A-Z]{1,3})\$?(\d+)$/.exec(ref)!
  const col = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  return [Number(m[2]) - 1, col]
}

/**
 * Works out a formula, for the value stored beside it: Excel recalculates
 * on opening, but a preview (Quick Look, the iPhone's Files, a mail
 * attachment) only shows what's stored, and a sheet of blank totals looks
 * broken. Covers what a model writes for a budget or a table -- arithmetic,
 * cell references, SUM, AVERAGE, MIN, MAX, COUNT, ROUND, ABS -- and gives
 * up (undefined) on anything else, leaving that one for Excel.
 */
export function evaluate(formula: string, valueAt: (row: number, col: number) => number | undefined): number | undefined {
  const tokens = formula.toUpperCase().match(/\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\d+(?:\.\d+)?|[A-Z]+(?=\()|[-+*/(),]|\S/g) ?? []
  let i = 0
  const peek = (): string | undefined => tokens[i]
  const take = (want?: string): string => {
    const t = tokens[i++]
    if (t === undefined || (want !== undefined && t !== want)) throw new Error('bad formula')
    return t
  }
  const cells = (ref: string): number[] => {
    const [from, to = from] = ref.split(':') as [string, string?]
    const [r1, c1] = refAt(from); const [r2, c2] = refAt(to!)
    const out: number[] = []
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        const v = valueAt(r, c)
        if (v !== undefined) out.push(v)
      }
    }
    return out
  }
  const FUNCS: Record<string, (args: number[][]) => number> = {
    SUM: (a) => a.flat().reduce((x, y) => x + y, 0),
    AVERAGE: (a) => { const v = a.flat(); if (!v.length) throw new Error('#DIV/0!'); return v.reduce((x, y) => x + y, 0) / v.length },
    MIN: (a) => Math.min(...a.flat()),
    MAX: (a) => Math.max(...a.flat()),
    COUNT: (a) => a.flat().length,
    ABS: (a) => Math.abs(a[0]![0]!),
    ROUND: (a) => { const f = 10 ** (a[1]?.[0] ?? 0); return Math.round(a[0]![0]! * f) / f },
  }
  // An argument: a range gives its numbers, anything else one number.
  const arg = (): number[] => (/^\$?[A-Z]{1,3}\$?\d+:/.test(peek() ?? '') ? cells(take()) : [expr()])
  function factor(): number {
    const t = take()
    if (t === '-') return -factor()
    if (t === '+') return factor()
    if (t === '(') { const v = expr(); take(')'); return v }
    if (/^\d/.test(t)) return Number(t)
    if (/^\$?[A-Z]{1,3}\$?\d+$/.test(t)) { const [r, c] = refAt(t); return valueAt(r, c) ?? 0 }
    const fn = FUNCS[t]
    if (!fn) throw new Error('unknown')
    take('(')
    const args: number[][] = []
    if (peek() !== ')') { args.push(arg()); while (peek() === ',') { take(); args.push(arg()) } }
    take(')')
    return fn(args)
  }
  function term(): number {
    let v = factor()
    while (peek() === '*' || peek() === '/') v = take() === '*' ? v * factor() : v / factor()
    return v
  }
  function expr(): number {
    let v = term()
    while (peek() === '+' || peek() === '-') v = take() === '+' ? v + term() : v - term()
    return v
  }
  try {
    const v = expr()
    if (i !== tokens.length || !Number.isFinite(v)) return undefined
    // Floating point noise (0.1 + 0.2) rounded off.
    return Number(v.toPrecision(12))
  } catch {
    return undefined
  }
}

/** A one-sheet workbook: numbers as numbers, the header row bold and frozen, columns wide enough to read. */
export function xlsx(rows: string[][]): Buffer {
  return zip(xlsxParts(rows))
}

/** The workbook's parts, by path in the zip. */
export function xlsxParts(input: string[][]): [string, string][] {
  const rows = evenRows(input)
  const grid: Cell[][] = rows.map((row, r) => row.map((v): Cell => (r === 0 ? { kind: 'text', text: v } : readCell(v))))
  // Formula values, worked out on demand. A cell met again while it's being
  // worked out is a cycle: that throws, and evaluate() gives up on the lot.
  const results = new Map<string, number | undefined>()
  const working = new Set<string>()
  const valueAt = (r: number, c: number): number | undefined => {
    const cell = grid[r]?.[c]
    if (!cell || cell.kind === 'text') return undefined
    if (cell.kind === 'number') return Number(cell.value)
    const key = `${r},${c}`
    if (results.has(key)) return results.get(key)
    if (working.has(key)) throw new Error('cycle')
    working.add(key)
    const v = evaluate(cell.formula, valueAt)
    working.delete(key)
    results.set(key, v)
    return v
  }
  // A formula takes the look of the first formatted number it refers to: a total of dollars is in dollars.
  // Through other formulas too (a total of variances), a few deep at most.
  const styleFor = (formula: string, depth = 0): number => {
    for (const ref of formula.toUpperCase().match(/\$?[A-Z]{1,3}\$?\d+/g) ?? []) {
      const [r, c] = refAt(ref)
      const cell = grid[r]?.[c]
      if (cell?.kind === 'number' && cell.style) return cell.style
      if (cell?.kind === 'formula' && depth < 4) {
        const style = styleFor(cell.formula, depth + 1)
        if (style) return style
      }
    }
    return STYLE.plain
  }
  const widths: number[] = []
  const cells = grid.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    widths[c] = Math.max(widths[c] ?? 0, rows[r]![c]!.trim().length)
    const ref = `${columnName(c)}${r + 1}`
    if (cell.kind === 'formula') {
      const style = styleFor(cell.formula)
      const v = valueAt(r, c)
      return `<c r="${ref}"${style ? ` s="${style}"` : ''}><f>${xmlText(cell.formula)}</f>${v === undefined ? '' : `<v>${v}</v>`}</c>`
    }
    if (cell.kind === 'number') return `<c r="${ref}"${cell.style ? ` s="${cell.style}"` : ''}><v>${cell.value}</v></c>`
    return `<c r="${ref}"${r === 0 ? ` s="${STYLE.header}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlText(cell.text)}</t></is></c>`
  }).join('')}</row>`).join('')
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, w + 2))}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const frozen = rows.length > 1
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : ''
  const xf = (numFmt: number, font = 0): string => `<xf numFmtId="${numFmt}" fontId="${font}" fillId="0" borderId="0" xfId="0"${font ? ' applyFont="1"' : ''}${numFmt ? ' applyNumberFormat="1"' : ''}/>`
  // In STYLE's order. 164 is the one custom format (dollars); 9, 10, 3 and 4 are Excel's built-in 0%, 0.00%, #,##0 and #,##0.00.
  const cellXfs = [xf(0), xf(0, 1), xf(164), xf(9), xf(10), xf(3), xf(4)]
  const xml = XML
  return [
    ['[Content_Types].xml', `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    // fullCalcOnLoad: Excel works every formula out again on opening, including any evaluate() gave up on.
    ['xl/workbook.xml', `${xml}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', `${xml}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${cellXfs.length}">${cellXfs.join('')}</cellXfs></styleSheet>`],
    ['xl/worksheets/sheet1.xml', `${xml}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${frozen}${cols}<sheetData>${cells}</sheetData></worksheet>`],
  ]
}

/** A zip of the given files, deflated: the container an .xlsx is. */
export function zip(files: [string, string][]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const raw = Buffer.from(text)
    const data = zlib.deflateRawSync(raw)
    const nameBuf = Buffer.from(name)
    const crc = zlib.crc32(raw)
    // Shared by the local header and the central directory entry: version 2.0,
    // UTF-8 names, deflate, 1980-01-01 00:00, CRC and sizes.
    const common = Buffer.alloc(26)
    common.writeUInt16LE(20, 0); common.writeUInt16LE(0x0800, 2); common.writeUInt16LE(8, 4)
    common.writeUInt16LE(0, 6); common.writeUInt16LE(0x21, 8); common.writeUInt32LE(crc, 10)
    common.writeUInt32LE(data.length, 14); common.writeUInt32LE(raw.length, 18); common.writeUInt16LE(nameBuf.length, 22)
    const local = Buffer.concat([u32(0x04034b50), common, nameBuf])
    // Then comment length, disk, attributes (all zero) and where the local header is.
    const tail = Buffer.alloc(14); tail.writeUInt32LE(offset, 10)
    central.push(Buffer.concat([u32(0x02014b50), u16(20), common, tail, nameBuf]))
    parts.push(local, data)
    offset += local.length + data.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }

// --- Word ------------------------------------------------------------------

interface Marks { b?: boolean; i?: boolean; s?: boolean; code?: boolean; link?: boolean }
interface ParaProps { style?: string; numId?: number; level?: number; indent?: number; align?: string | null }

/** What a document collects as it's written: hyperlink targets and one numbering per ordered list. */
class DocParts {
  links: string[] = []
  /** Start numbers of ordered lists; list n is numbering n + 2 (1 is bullets). */
  ordered: number[] = []
  link(url: string): string { this.links.push(url); return `rIdLink${this.links.length}` }
  orderedList(start: number): number { this.ordered.push(start); return this.ordered.length + 1 }
}

function run(text: string, m: Marks): string {
  const props = [
    m.link ? '<w:rStyle w:val="Hyperlink"/>' : m.code ? '<w:rStyle w:val="CodeChar"/>' : '',
    m.b ? '<w:b/>' : '', m.i ? '<w:i/>' : '', m.s ? '<w:strike/>' : '',
  ].join('')
  // Tabs are their own element; a line break inside a paragraph's text is just a space in Markdown.
  const body = text.replace(/\r?\n/g, ' ').split('\t').map((t) => `<w:t xml:space="preserve">${xmlText(t)}</w:t>`).join('<w:tab/>')
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>`
}

function inline(nodes: PhrasingContent[], m: Marks, doc: DocParts): string {
  return nodes.map((n) => {
    switch (n.type) {
      case 'text': return run(n.value, m)
      case 'strong': return inline(n.children, { ...m, b: true }, doc)
      case 'emphasis': return inline(n.children, { ...m, i: true }, doc)
      case 'delete': return inline(n.children, { ...m, s: true }, doc)
      case 'inlineCode': return run(n.value, { ...m, code: true })
      case 'break': return '<w:r><w:br/></w:r>'
      case 'link': return `<w:hyperlink r:id="${doc.link(n.url)}">${inline(n.children, { ...m, link: true }, doc)}</w:hyperlink>`
      case 'image': return n.alt ? run(`[${n.alt}]`, m) : ''
      case 'html': return run(n.value.replace(/<[^>]*>/g, ''), m)
      default: return 'children' in n ? inline(n.children as PhrasingContent[], m, doc) : 'value' in n ? run(String(n.value), m) : ''
    }
  }).join('')
}

function para(p: ParaProps, body: string): string {
  // Word checks the order of these.
  const props = [
    p.style ? `<w:pStyle w:val="${p.style}"/>` : '',
    p.numId ? `<w:numPr><w:ilvl w:val="${p.level ?? 0}"/><w:numId w:val="${p.numId}"/></w:numPr>` : '',
    p.indent != null ? `<w:ind w:left="${720 * (p.indent + 1)}"/>` : '',
    p.align === 'center' || p.align === 'right' ? `<w:jc w:val="${p.align}"/>` : '',
  ].join('')
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${body}</w:p>`
}

/** Where a block sits: how deep in lists (-1 for none), and inside a quote. */
interface At { level: number; quote?: boolean }

function blocks(nodes: (RootContent | BlockContent | DefinitionContent)[], doc: DocParts, at: At): string {
  return nodes.map((n) => block(n, doc, at)).join('')
}

function block(n: RootContent, doc: DocParts, at: At): string {
  const style = at.quote ? 'Quote' : undefined
  const indent = at.level >= 0 ? at.level : undefined
  switch (n.type) {
    case 'heading': return para({ style: `Heading${Math.min(n.depth, 6)}` }, inline(n.children, {}, doc))
    case 'paragraph': return para({ style, indent }, inline(n.children, {}, doc))
    case 'blockquote': return blocks(n.children, doc, { ...at, quote: true })
    case 'list': return list(n, doc, at)
    case 'table': return table(n, doc)
    case 'code': return para({ style: 'Code', indent }, n.value.split('\n').map((line, i) => (i ? '<w:r><w:br/></w:r>' : '') + run(line, {})).join(''))
    case 'thematicBreak': return para({ style: 'Rule' }, '')
    case 'html': {
      const text = n.value.replace(/<[^>]*>/g, '').trim()
      return text ? para({ style, indent }, run(text, {})) : ''
    }
    default: return 'children' in n ? blocks(n.children as RootContent[], doc, at) : ''
  }
}

/** Each item's first paragraph carries the bullet or number; the rest sit indented under it. */
function list(n: List, doc: DocParts, at: At): string {
  const numId = n.ordered ? doc.orderedList(n.start ?? 1) : 1
  const level = Math.min(at.level + 1, 8)
  const style = at.quote ? 'Quote' : undefined
  return n.children.map((item) => {
    const box = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : ''
    let first = true
    return item.children.map((child) => {
      if (child.type === 'paragraph') {
        // A checklist item's box stands in for its bullet.
        const props: ParaProps = first && !box ? { style, numId, level } : { style, indent: level }
        const body = (first && box ? run(box, {}) : '') + inline(child.children, {}, doc)
        first = false
        return para(props, body)
      }
      // An item that opens with something else (a code block, say) still gets its bullet.
      const lead = first ? para({ style, numId, level }, box ? run(box, {}) : '') : ''
      first = false
      return lead + block(child, doc, { ...at, level })
    }).join('') || para({ style, numId, level }, box ? run(box, {}) : '')
  }).join('')
}

function table(n: Table, doc: DocParts): string {
  const cols = Math.max(1, ...n.children.map((r) => r.children.length))
  const width = Math.floor(9360 / cols)
  const border = (side: string): string => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C8C8CC"/>`
  const rows = n.children.map((row, r) => {
    const cells = Array.from({ length: cols }, (_, c) => {
      const cell = row.children[c]
      const shade = r === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F4"/>' : ''
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${para({ style: 'TableText', align: n.align?.[c] }, cell ? inline(cell.children, r === 0 ? { b: true } : {}, doc) : '')}</w:tc>`
    }).join('')
    return `<w:tr>${r === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`
  }).join('')
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>${rows}</w:tbl>${para({ style: 'TableAfter' }, '')}`
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

const WORD_STYLES = `${XML}<w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[[1, 36, 360], [2, 30, 300], [3, 26, 240], [4, 24, 200], [5, 22, 200], [6, 22, 200]].map(([d, sz, before]) =>
  `<w:style w:type="paragraph" w:styleId="Heading${d}"><w:name w:val="heading ${d}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${d! - 1}"/></w:pPr><w:rPr><w:b/>${d! >= 5 ? '<w:i/>' : ''}<w:color w:val="1D1D1F"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="C8C8CC"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F4"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableAfter"><w:name w:val="Table After"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80" w:line="120" w:lineRule="auto"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Rule"><w:name w:val="Rule"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8C8CC"/></w:pBdr></w:pPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Consolas"/><w:sz w:val="19"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F4"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`

/**
 * Bullets (• ◦ ▪) and numbers (1. a. i.), nine levels each, indented a half
 * inch a level. Each numbered list gets its own definition starting at its
 * own number: some readers ignore Word's "restart at" override and would
 * carry on counting from the list before.
 */
function numbering(ordered: number[]): string {
  const levels = (kind: 'bullet' | 'number', start = 1): string => Array.from({ length: 9 }, (_, l) => {
    const fmt = kind === 'bullet' ? 'bullet' : ['decimal', 'lowerLetter', 'lowerRoman'][l % 3]
    const text = kind === 'bullet' ? ['•', '◦', '▪'][l % 3] : `%${l + 1}.`
    return `<w:lvl w:ilvl="${l}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`
  }).join('')
  const abstract = (id: number, body: string): string => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${body}</w:abstractNum>`
  const num = (id: number): string => `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`
  const ids = ordered.map((_, i) => i + 2)
  return `${XML}<w:numbering ${W}>${abstract(1, levels('bullet'))}${ordered.map((start, i) => abstract(ids[i]!, levels('number', start))).join('')}${num(1)}${ids.map(num).join('')}</w:numbering>`
}

/** A Word document from Markdown, US Letter with one-inch margins. */
export function docx(markdown: string): Buffer {
  return zip(docxParts(markdown))
}

/** The document's parts, by path in the zip. */
export function docxParts(markdown: string): [string, string][] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
  const doc = new DocParts()
  const body = blocks(tree.children, doc, { level: -1 }) || para({}, '')
  const rel = (id: string, type: string, target: string, external = false): string =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${xmlText(target)}"${external ? ' TargetMode="External"' : ''}/>`
  return [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'officeDocument', 'word/document.xml')}</Relationships>`],
    ['word/_rels/document.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rIdStyles', 'styles', 'styles.xml')}${rel('rIdNumbering', 'numbering', 'numbering.xml')}${doc.links.map((url, i) => rel(`rIdLink${i + 1}`, 'hyperlink', url, true)).join('')}</Relationships>`],
    ['word/styles.xml', WORD_STYLES],
    ['word/numbering.xml', numbering(doc.ordered)],
    ['word/document.xml', `${XML}<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`],
  ]
}
