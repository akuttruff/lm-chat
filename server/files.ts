import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CONVERTED, type FileSource } from '../src/lib/export.ts'
import { docx, parseDelimited, xlsx } from './office.ts'

/**
 * Files made from what the model wrote. The model can only write text, so
 * a PDF, Word document or spreadsheet is written as Markdown, HTML or CSV in
 * a fence named for the file it should become (```markdown letter.pdf), and
 * made here when it's downloaded:
 *
 * - PDF and PNG: headless Chrome prints or screenshots the page.
 * - Word from Markdown, and Excel: written directly (office.ts). macOS's
 *   own converter drops tables and lists from Word files.
 * - Word from HTML, OpenDocument, RTF: macOS's textutil converts the HTML.
 *
 * The page Chrome opens is the model's -- and the model may have read a
 * web page that told it what to write -- so Chrome runs with every network
 * request sent to a dead proxy, loopback included: the page can't reach
 * this Mac's own services or send anything anywhere. textutil is told not
 * to load anything either. Scripts still run, so a chart drawn by inline
 * script prints; one loaded from a CDN doesn't.
 */

export class FileError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

/** The most text a file is made from: a long report is well under this. */
export const MAX_FILE_CHARS = 1_000_000
const CHROME_TIMEOUT_MS = 45_000
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export interface MadeFile { name: string; type: string; data: Buffer }

/** "Q3 report.pdf" -> "Q3-report.pdf": a name safe for a header and a disk. */
export function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+/, '').slice(0, 100)
  return base || 'file'
}

/** One file from a fence's text, checked against what each format can be made from. */
export async function makeFile(rawName: unknown, rawSource: unknown, text: unknown): Promise<MadeFile> {
  if (typeof rawName !== 'string' || !rawName.trim()) throw new FileError('A file name is required.')
  if (typeof text !== 'string' || !text.trim()) throw new FileError('There is nothing to put in the file.')
  if (text.length > MAX_FILE_CHARS) throw new FileError(`At most ${MAX_FILE_CHARS.toLocaleString('en-US')} characters.`)
  const name = safeName(rawName)
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const target = CONVERTED[ext]
  if (!target) throw new FileError(`LM Chat can't make .${ext || '?'} files.`)
  const source = rawSource as FileSource
  if (!target.from.includes(source)) throw new FileError(`${target.label} files can't be made from ${String(rawSource)}.`)
  const data = await queued(() => convert(ext, source, text, name))
  return { name, type: target.type, data }
}

// One conversion at a time: each Chrome is a few hundred MB, and a reply
// with several files shouldn't start them all at once.
let chain: Promise<unknown> = Promise.resolve()
function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job)
  chain = run.catch(() => undefined)
  return run
}

async function convert(ext: string, source: FileSource, text: string, name: string): Promise<Buffer> {
  if (ext === 'xlsx') return xlsx(parseDelimited(text, source === 'tsv' ? '\t' : ','))
  if (ext === 'docx' && source === 'markdown') return docx(text)
  const title = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
  const html = source === 'svg' ? svgPage(text) : source === 'html' ? htmlPage(text, title) : documentHtml(title, markdownHtml(text))
  if (ext === 'html') return Buffer.from(html)
  return withTemp(async (dir) => {
    const input = path.join(dir, 'in.html')
    const output = path.join(dir, `out.${ext}`)
    fs.writeFileSync(input, html)
    if (ext === 'pdf') await chrome([`--no-pdf-header-footer`, `--print-to-pdf=${output}`], input, output)
    else if (ext === 'png') {
      const [w, h] = source === 'svg' ? svgSize(text) : [1200, 1600]
      await chrome([`--window-size=${w},${h}`, '--force-device-scale-factor=2', '--hide-scrollbars', `--screenshot=${output}`], input, output)
    } else await textutil(ext, input, output)
    return fs.readFileSync(output)
  })
}

async function withTemp<T>(job: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-file-'))
  try { return await job(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

/** Markdown as HTML, the way a reply renders on screen (tables, strikethrough, task lists). */
export function markdownHtml(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text))
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A printable page: readable type, ruled tables, breaks kept out of headings and rows. */
const DOC_STYLE = `
@page { margin: 18mm 16mm; }
body { font: 11.5pt/1.55 Georgia, "Times New Roman", serif; color: #1d1d1f; max-width: 46em; margin: 0 auto; padding: 24px; }
h1, h2, h3, h4 { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; line-height: 1.25; break-after: avoid; }
h1 { font-size: 22pt; margin: 0 0 12pt; } h2 { font-size: 16pt; margin: 20pt 0 8pt; } h3 { font-size: 13pt; margin: 14pt 0 6pt; }
p, ul, ol { margin: 0 0 9pt; } li { margin-bottom: 3pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 12pt; font-size: 10pt; }
th, td { border: 1px solid #c8c8cc; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #f2f2f4; } tr { break-inside: avoid; }
code { font: 9.5pt "SF Mono", Menlo, monospace; background: #f2f2f4; padding: 1px 4px; border-radius: 3px; }
pre { background: #f2f2f4; padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 9pt; padding-left: 12px; border-left: 3px solid #c8c8cc; color: #555; }
img { max-width: 100%; } hr { border: none; border-top: 1px solid #c8c8cc; margin: 16pt 0; }
@media print { body { padding: 0; max-width: none; } }
`

export function documentHtml(title: string, body: string): string {
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOC_STYLE}</style></head>\n<body>\n${body}\n</body></html>\n`
}

/** HTML the model wrote: a whole page is used as it is, a fragment gets the document's page around it. */
function htmlPage(text: string, title: string): string {
  return /<html[\s>]|<!doctype html/i.test(text) ? text : documentHtml(title, text)
}

function svgPage(svg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#fff}svg{display:block;max-width:100%;height:auto}</style></head><body>${svg}</body></html>`
}

/** An SVG's drawn size, from width/height or its viewBox, for a screenshot that fits it. */
export function svgSize(svg: string): [number, number] {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const attr = (n: string): number => Number(new RegExp(`\\s${n}="([\\d.]+)(px)?"`).exec(tag)?.[1])
  let w = attr('width'), h = attr('height')
  if (!(w > 0 && h > 0)) {
    const vb = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(tag)
    w = Number(vb?.[1]); h = Number(vb?.[2])
  }
  if (!(w > 0 && h > 0)) return [1200, 800]
  // Small drawings are scaled up to a useful size; huge ones down.
  const scale = Math.min(4000 / w, 4000 / h, Math.max(1, 800 / w))
  return [Math.round(w * scale), Math.round(h * scale)]
}

/** Runs headless Chrome on a page until it has written `output`; no network at all (see the top). */
function chrome(args: string[], input: string, output: string): Promise<void> {
  if (!fs.existsSync(CHROME)) return Promise.reject(new FileError('Making PDFs and images needs Google Chrome on the Mac.', 501))
  return withTemp((profile) => new Promise<void>((resolve, reject) => {
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
      `--user-data-dir=${profile}`, ...args, `file://${input}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    let log = ''
    let settled = false
    // Chrome can linger after writing the file, so it's stopped once it
    // says it has -- the whole process group, helpers included.
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ }
      if (err) reject(err)
      else resolve()
    }
    const made = (): boolean => { try { return fs.statSync(output).size > 0 } catch { return false } }
    child.stderr!.on('data', (d: Buffer) => {
      log = (log + d.toString()).slice(-2000)
      if (/bytes written to file|Written to file/i.test(log) && made()) finish()
    })
    child.on('error', (e) => finish(new FileError(`Chrome couldn't start: ${e.message}`, 500)))
    child.on('exit', () => finish(made() ? undefined : new FileError("Chrome didn't make the file.", 500)))
    const timer = setTimeout(() => finish(made() ? undefined : new FileError('Making the file took too long.', 504)), CHROME_TIMEOUT_MS)
  }))
}

function textutil(ext: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/textutil', ['-noload', '-format', 'html', '-convert', ext, '-output', output, input], { timeout: 60_000 }, (err, _out, stderr) => {
      if (err) reject(new FileError(`textutil: ${String(stderr || err.message).trim()}`, 500))
      else resolve()
    })
  })
}
