import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { columnName, docxParts, evaluate, evenRows, parseDelimited, readCell, xlsx, xlsxParts, zip } from './office.ts'

/** The files in a zip, read back from its local headers. */
function unzip(buf: Buffer): Record<string, string> {
  const files: Record<string, string> = {}
  let at = 0
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18)
    const nameLen = buf.readUInt16LE(at + 26)
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString()
    const start = at + 30 + nameLen
    const raw = zlib.inflateRawSync(buf.subarray(start, start + size))
    expect(zlib.crc32(raw)).toBe(buf.readUInt32LE(at + 14))
    files[name] = raw.toString()
    at = start + size
  }
  // The central directory lists every file, and the end record says where it starts.
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(buf.readUInt16LE(end + 10)).toBe(Object.keys(files).length)
  expect(buf.readUInt32LE(end + 16)).toBe(at)
  return files
}

const part = (parts: [string, string][], name: string): string => parts.find(([n]) => n === name)![1]

describe('zip', () => {
  it('reads back what went in', () => {
    expect(unzip(zip([['a.txt', 'hello'], ['dir/b.xml', '<x>é</x>']]))).toEqual({ 'a.txt': 'hello', 'dir/b.xml': '<x>é</x>' })
  })
})

describe('spreadsheets', () => {
  it('reads CSV with quoted separators, quotes and line breaks', () => {
    expect(parseDelimited('a,b\n"x, y","say ""hi"""\r\n"two\nlines",3\n\n', ',')).toEqual([
      ['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3'],
    ])
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']])
    // A blank row inside is kept, so formulas' row numbers still line up; trailing ones go.
    expect(parseDelimited('a\n,\nb\n,,\n', ',')).toEqual([['a'], ['', ''], ['b']])
  })

  it('names columns past Z', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA'])
  })

  it('writes numbers as numbers and keeps codes like 007 as text, with a bold header', () => {
    const sheet = part(xlsxParts([['Item', 'Cost'], ['Rent & bills', '1200.50'], ['Code', '007']]), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Item</t></is></c>')
    expect(sheet).toContain('<c r="B2"><v>1200.50</v></c>')
    expect(sheet).toContain('Rent &amp; bills')
    expect(sheet).toContain('<t xml:space="preserve">007</t>')
  })

  it('reads dollars, percentages and grouped thousands as numbers, and keeps formulas', () => {
    expect(readCell('$1,200.50')).toEqual({ kind: 'number', value: '1200.50', style: 2 })
    expect(readCell('-$15.00')).toEqual({ kind: 'number', value: '-15.00', style: 2 })
    expect(readCell('($15.00)')).toEqual({ kind: 'number', value: '-15.00', style: 2 })
    expect(readCell('15%')).toEqual({ kind: 'number', value: '0.15', style: 3 })
    expect(readCell('14.3%')).toEqual({ kind: 'number', value: '0.143', style: 4 })
    expect(readCell('12,000')).toEqual({ kind: 'number', value: '12000', style: 5 })
    expect(readCell('=SUM(B2:B9)')).toEqual({ kind: 'formula', formula: 'SUM(B2:B9)' })
    for (const text of ['007', 'A1', '$1,20', '555-1234', "=cmd|' /c calc'!A1", '=']) expect(readCell(text).kind).toBe('text')
  })

  it('joins amounts split by an unquoted thousands comma', () => {
    expect(evenRows([['Item', 'Planned', 'Actual', 'Notes'], ['Salary', '$4', '500.00', '-$1', '200.50', 'Monthly, net']])).toEqual([
      ['Item', 'Planned', 'Actual', 'Notes'], ['Salary', '$4,500.00', '-$1,200.50', 'Monthly, net'],
    ])
  })

  it('puts an unquoted comma\'s spill-over back in the last column', () => {
    expect(evenRows([['Item', 'Cost', 'Notes'], ['Utilities', '150', 'Electric', ' water', ' internet'], ['Rent', '1200']])).toEqual([
      ['Item', 'Cost', 'Notes'], ['Utilities', '150', 'Electric, water, internet'], ['Rent', '1200'],
    ])
  })

  it('freezes the header, sizes columns to their contents, and recalculates formulas on opening', () => {
    const parts = xlsxParts([['Category', 'Amount'], ['Groceries and household', '$400.00'], ['Total', '=SUM(B2:B2)']])
    const sheet = part(parts, 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('state="frozen"')
    expect(sheet).toContain('<col min="1" max="1" width="25" customWidth="1"/>')
    expect(sheet).toContain('<c r="B2" s="2"><v>400.00</v></c>')
    // Worked out and stored, for previews that don't calculate, and shown in dollars like what it adds up.
    expect(sheet).toContain('<c r="B3" s="2"><f>SUM(B2:B2)</f><v>400</v></c>')
    expect(part(parts, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
    expect(part(parts, 'xl/styles.xml')).toContain('formatCode="&quot;$&quot;#,##0.00"')
  })

  it('works out the formulas a budget uses, and gives up on the rest', () => {
    // B2..B4 = 10, 20, 30; C2 = 4.
    const grid: Record<string, number> = { '1,1': 10, '2,1': 20, '3,1': 30, '1,2': 4 }
    const at = (r: number, c: number): number | undefined => grid[`${r},${c}`]
    expect(evaluate('SUM(B2:B4)', at)).toBe(60)
    expect(evaluate('$B$2-$C2', at)).toBe(6)
    expect(evaluate('AVERAGE(B2:B4)+MAX(B2:B4)*2', at)).toBe(80)
    expect(evaluate('(B2+B3)/C2', at)).toBe(7.5)
    expect(evaluate('ROUND(B3/3,2)', at)).toBe(6.67)
    expect(evaluate('-SUM(B2,B3, 5)', at)).toBe(-35)
    expect(evaluate('0.1+0.2', at)).toBe(0.3)
    expect(evaluate('B9*2', at)).toBe(0)
    for (const f of ['VLOOKUP(B2,A1:B4,2)', 'B2/0', 'SUM(B2:B4', 'B2 B3', 'AVERAGE(Z1:Z3)']) expect(evaluate(f, at)).toBeUndefined()
  })

  it('shows a total of formulas in the format of what they work from', () => {
    const sheet = part(xlsxParts([['Plan', 'Spent', 'Left'], ['$10.00', '$4.00', '=A2-B2'], ['', '', '=SUM(C2:C2)']]), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="C3" s="2"><f>SUM(C2:C2)</f><v>6</v></c>')
  })

  it('works out formulas that refer to other formulas, and leaves a cycle for Excel', () => {
    const sheet = part(xlsxParts([['A', 'B'], ['5', '=A2*2'], ['=B2+1', '=B3'], ['=A2', '=A2+B2+A3']]), 'xl/worksheets/sheet1.xml')
    expect(sheet).toContain('<c r="B2"><f>A2*2</f><v>10</v></c>')
    expect(sheet).toContain('<c r="A3"><f>B2+1</f><v>11</v></c>')
    expect(sheet).toContain('<c r="B3"><f>B3</f></c>')
    expect(sheet).toContain('<c r="B4"><f>A2+B2+A3</f><v>26</v></c>')
  })

  it('packs a workbook Excel can open', () => {
    const files = unzip(xlsx([['a']]))
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'])
  })
})

describe('Word documents', () => {
  const doc = (md: string): string => part(docxParts(md), 'word/document.xml')

  it('styles headings and marks emphasis', () => {
    const xml = doc('# Title\n\nA **bold**, *slanted*, ~~struck~~ and `coded` word.')
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>')
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t>')
    expect(xml).toContain('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">slanted</w:t>')
    expect(xml).toContain('<w:strike/>')
    expect(xml).toContain('<w:rStyle w:val="CodeChar"/>')
  })

  it('keeps tables, with a bold, shaded header row', () => {
    const xml = doc('| Day | Meal |\n|---|--:|\n| Mon | Oats |')
    expect(xml).toContain('<w:tbl>')
    expect(xml.match(/<w:tr>/g)).toHaveLength(2)
    expect(xml).toContain('<w:tblHeader/>')
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Day</w:t>')
    expect(xml).toContain('<w:jc w:val="right"/>')
  })

  it('numbers each ordered list from its own start, and nests bullets a level down', () => {
    const parts = docxParts('1. one\n   - inner\n2. two\n\ntext\n\n3. three\n')
    const xml = part(parts, 'word/document.xml')
    expect(xml).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>')
    expect(xml).toContain('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>')
    expect(xml).toContain('<w:numId w:val="3"/>')
    const numbering = part(parts, 'word/numbering.xml')
    expect(numbering).toMatch(/<w:abstractNum w:abstractNumId="3">.*?<w:start w:val="3"\/>/)
  })

  it('shows a checklist box in place of a bullet', () => {
    const xml = doc('- [x] shipped\n- [ ] tested')
    expect(xml).toContain('☑ ')
    expect(xml).toContain('☐ ')
    expect(xml).not.toContain('<w:numPr>')
  })

  it('links out through relationships, escaping the address', () => {
    const parts = docxParts('[site](https://example.com/?a=1&b=2)')
    expect(part(parts, 'word/document.xml')).toContain('<w:hyperlink r:id="rIdLink1">')
    expect(part(parts, 'word/_rels/document.xml.rels')).toContain('Target="https://example.com/?a=1&amp;b=2" TargetMode="External"')
  })

  it('keeps code blocks\' lines and tabs, and drops characters XML can\'t hold', () => {
    const xml = doc('```\nfn() {\n\treturn\u0007 1\n}\n```')
    expect(xml).toContain('<w:pStyle w:val="Code"/>')
    expect(xml).toContain('<w:br/>')
    expect(xml).toContain('<w:tab/>')
    expect(xml).not.toContain('\u0007')
  })

  it('still writes a valid body for an empty document', () => {
    expect(doc('')).toContain('<w:body><w:p></w:p><w:sectPr>')
  })
})
