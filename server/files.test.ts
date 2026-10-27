import { describe, expect, it } from 'vitest'
import { documentHtml, makeFile, markdownHtml, safeName, svgSize } from './files.ts'

describe('making files', () => {
  it('keeps a file name to safe characters', () => {
    expect(safeName('Q3 report.pdf')).toBe('Q3-report.pdf')
    expect(safeName('../../etc/passwd.pdf')).toBe('passwd.pdf')
    expect(safeName('"; rm -rf.pdf')).toBe('rm-rf.pdf')
    expect(safeName('...')).toBe('file')
  })

  it('renders Markdown the way a reply does, tables included', () => {
    const html = markdownHtml('# Plan\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done')
    expect(html).toContain('<h1>Plan</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
  })

  it('makes a web page from Markdown, titled after the file', async () => {
    const file = await makeFile('trip-plan.html', 'markdown', '# Lisbon\n\n<script>alert(1)</script> & more')
    const html = file.data.toString()
    expect(file.type).toBe('text/html')
    expect(html).toContain('<title>trip plan</title>')
    expect(html).toContain('<h1>Lisbon</h1>')
    // Raw HTML in the Markdown is shown as text, as on screen, never run.
    expect(html).not.toContain('<script>')
  })

  it('wraps a page in a printable document', () => {
    const page = documentHtml('A <b> title', '<p>x</p>')
    expect(page).toContain('<title>A &lt;b&gt; title</title>')
    expect(page).toContain('@page')
  })

  it('sizes a PNG to the SVG, scaling up small drawings', () => {
    expect(svgSize('<svg width="1000" height="500">')).toEqual([1000, 500])
    expect(svgSize('<svg viewBox="0 0 200 100">')).toEqual([800, 400])
    expect(svgSize('<svg>')).toEqual([1200, 800])
    expect(svgSize('<svg width="10000" height="100">')).toEqual([4000, 40])
  })

  it('refuses what it can\'t make', async () => {
    await expect(makeFile('', 'markdown', 'x')).rejects.toThrow('A file name is required.')
    await expect(makeFile('a.exe', 'markdown', 'x')).rejects.toThrow("LM Chat can't make .exe files.")
    await expect(makeFile('a.png', 'markdown', 'x')).rejects.toThrow("PNG image files can't be made from markdown.")
    await expect(makeFile('a.pdf', 'markdown', 'x'.repeat(1_000_001))).rejects.toThrow('At most 1,000,000 characters.')
  })
})
