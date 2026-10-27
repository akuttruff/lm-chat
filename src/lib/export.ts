import type { Conversation, Message } from '../types.ts'
import { argsSummary } from './toolFormat.ts'

/**
 * A chat as Markdown, for copying or saving: your messages and the replies
 * in full, each tool call as a one-line note, reasoning and errors left
 * out. Replies are Markdown already, so they go in as they are.
 */
export function chatMarkdown(conv: Pick<Conversation, 'name' | 'createdAt' | 'messages'>, now: Date = new Date()): string {
  const title = conv.name || 'Chat'
  const started = new Date(conv.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  const exported = now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  const lines = [`# ${title}`, '', `_Started ${started} · exported from LM Chat ${exported}_`, '']
  for (const m of conv.messages) {
    const block = messageMarkdown(m)
    if (block) lines.push(block, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function messageMarkdown(m: Message): string | null {
  switch (m.role) {
    case 'user': {
      const images = (m.images ?? []).map((i) => `[image: ${i.name}]`)
      const body = [...images, (m.text || '').trim()].filter(Boolean).join('\n\n')
      return body ? `**You:**\n\n${body}` : null
    }
    case 'assistant': {
      const text = (m.text || '').trim()
      if (!text) return null
      return `**${m.instance || m.model || 'Assistant'}:**\n\n${text}`
    }
    case 'tool': {
      const name = (m.name || 'tool').replace(/[_-]+/g, ' ')
      const params = m.args && Object.keys(m.args).length ? ` — ${argsSummary(m.args)}` : ''
      return `> 🔧 ${name}${params}${m.failed ? ' (failed)' : ''}`
    }
    default:
      return null
  }
}

/** "transit-questions.md": the chat's name as a file name. */
export function exportFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${slug || 'chat'}.md`
}

/** Hand the browser a file to save. */
export function downloadText(fileName: string, text: string, type = 'text/markdown'): void {
  downloadBlob(fileName, new Blob([text], { type }))
}

/** Offers a blob to the browser as a file download. */
export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** File extension and MIME type for a fence's language tag; null for languages not worth saving as files. */
const FENCE_TYPES: Record<string, { ext: string; type: string }> = {
  markdown: { ext: 'md', type: 'text/markdown' }, md: { ext: 'md', type: 'text/markdown' },
  text: { ext: 'txt', type: 'text/plain' }, txt: { ext: 'txt', type: 'text/plain' }, plaintext: { ext: 'txt', type: 'text/plain' },
  csv: { ext: 'csv', type: 'text/csv' }, tsv: { ext: 'tsv', type: 'text/tab-separated-values' },
  json: { ext: 'json', type: 'application/json' }, yaml: { ext: 'yaml', type: 'text/yaml' }, yml: { ext: 'yml', type: 'text/yaml' },
  html: { ext: 'html', type: 'text/html' }, xml: { ext: 'xml', type: 'text/xml' }, svg: { ext: 'svg', type: 'image/svg+xml' },
  css: { ext: 'css', type: 'text/css' }, ics: { ext: 'ics', type: 'text/calendar' },
  javascript: { ext: 'js', type: 'text/javascript' }, js: { ext: 'js', type: 'text/javascript' },
  typescript: { ext: 'ts', type: 'text/plain' }, ts: { ext: 'ts', type: 'text/plain' },
  python: { ext: 'py', type: 'text/plain' }, py: { ext: 'py', type: 'text/plain' },
  bash: { ext: 'sh', type: 'text/plain' }, sh: { ext: 'sh', type: 'text/plain' }, shell: { ext: 'sh', type: 'text/plain' }, zsh: { ext: 'sh', type: 'text/plain' },
  sql: { ext: 'sql', type: 'text/plain' }, rtf: { ext: 'rtf', type: 'application/rtf' }, vcf: { ext: 'vcf', type: 'text/vcard' }, vcard: { ext: 'vcf', type: 'text/vcard' },
  tex: { ext: 'tex', type: 'text/plain' }, latex: { ext: 'tex', type: 'text/plain' }, srt: { ext: 'srt', type: 'text/plain' }, vtt: { ext: 'vtt', type: 'text/vtt' },
  rust: { ext: 'rs', type: 'text/plain' }, rs: { ext: 'rs', type: 'text/plain' }, go: { ext: 'go', type: 'text/plain' }, ruby: { ext: 'rb', type: 'text/plain' }, rb: { ext: 'rb', type: 'text/plain' },
  java: { ext: 'java', type: 'text/plain' }, swift: { ext: 'swift', type: 'text/plain' }, c: { ext: 'c', type: 'text/plain' }, cpp: { ext: 'cpp', type: 'text/plain' },
  tsx: { ext: 'tsx', type: 'text/plain' }, jsx: { ext: 'jsx', type: 'text/plain' }, kotlin: { ext: 'kt', type: 'text/plain' }, php: { ext: 'php', type: 'text/plain' }, toml: { ext: 'toml', type: 'text/plain' }, ini: { ext: 'ini', type: 'text/plain' },
}

/** "meal-plan": the first Markdown heading, or the first line, as a slug; empty when there is none. */
function slugOf(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1] ?? text.split('\n').find((l) => l.trim())?.replace(/^[\s#*>-]+/, '') ?? ''
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/**
 * Files the server makes from what the model wrote (server/files.ts): a
 * Markdown or HTML block named report.pdf comes back as a PDF, a CSV named
 * budget.xlsx as a spreadsheet. `from` is what each can be made from.
 */
export type FileSource = 'markdown' | 'html' | 'svg' | 'csv' | 'tsv'
export const CONVERTED: Record<string, { type: string; label: string; from: FileSource[] }> = {
  pdf: { type: 'application/pdf', label: 'PDF', from: ['markdown', 'html', 'svg'] },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word', from: ['markdown', 'html'] },
  odt: { type: 'application/vnd.oasis.opendocument.text', label: 'OpenDocument', from: ['markdown', 'html'] },
  rtf: { type: 'application/rtf', label: 'Rich text', from: ['markdown', 'html'] },
  html: { type: 'text/html', label: 'Web page', from: ['markdown'] },
  png: { type: 'image/png', label: 'PNG image', from: ['svg', 'html'] },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel', from: ['csv', 'tsv'] },
}

/** What a fence's language says its text is, for conversion; plain text is read as Markdown. */
const SOURCES: Record<string, FileSource> = {
  markdown: 'markdown', md: 'markdown', text: 'markdown', txt: 'markdown', plaintext: 'markdown',
  html: 'html', svg: 'svg', csv: 'csv', tsv: 'tsv',
}

/** A fence tagged with the target itself (```pdf, ```xlsx): what its text most likely is. */
const TARGET_TAGS: Record<string, { ext: string; source: FileSource }> = {
  pdf: { ext: 'pdf', source: 'markdown' }, docx: { ext: 'docx', source: 'markdown' }, word: { ext: 'docx', source: 'markdown' },
  odt: { ext: 'odt', source: 'markdown' }, xlsx: { ext: 'xlsx', source: 'csv' }, excel: { ext: 'xlsx', source: 'csv' },
}

export interface FenceFile {
  name: string
  type: string
  /** Set when the file is made on the server from the block's text, which is this. */
  convert?: FileSource
}

/**
 * What a fenced block would be saved as: a Markdown block headed "# Meal plan"
 * becomes meal-plan.md, a bare one snippet.md. A fence with a file name for
 * a language (```markdown meal-plan.md) is taken at its word, and a name in
 * a format the server makes (```markdown cover-letter.pdf) is converted.
 * Blocks in languages with no obvious file form -- or none -- are not offered.
 */
export function fenceFile(info: string | undefined, code: string): FenceFile | null {
  const [rawLang = '', ...rest] = (info ?? '').trim().split(/\s+/)
  const lang = rawLang.toLowerCase()
  const named = rest.find((w) => /^[\w.-]+\.[a-z0-9]{1,8}$/i.test(w))
  const known = FENCE_TYPES[lang]
  const tagged = TARGET_TAGS[lang]
  if (named) {
    const ext = /\.([a-z0-9]+)$/i.exec(named)![1]!.toLowerCase()
    const target = CONVERTED[ext]
    const source = tagged && tagged.ext === ext ? tagged.source : SOURCES[lang]
    if (target && source && target.from.includes(source)) return { name: named, type: target.type, convert: source }
    return { name: named, type: known?.type ?? target?.type ?? 'text/plain' }
  }
  // A CSV's first line is its column names, no title: such a sheet is just "spreadsheet".
  if (tagged) return { name: `${(tagged.source === 'csv' ? '' : slugOf(code)) || (tagged.source === 'csv' ? 'spreadsheet' : 'document')}.${tagged.ext}`, type: CONVERTED[tagged.ext]!.type, convert: tagged.source }
  if (!known) return null
  // A whole web page is a file whether or not it was named: called after its <title>.
  if (known.ext === 'html' && isWholePage(code)) {
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(code)?.[1] ?? ''
    return { name: `${slugOf(title) || 'page'}.html`, type: known.type }
  }
  const base = known.ext === 'md' || known.ext === 'txt' ? slugOf(code) : ''
  return { name: `${base || 'snippet'}.${known.ext}`, type: known.type }
}

/** HTML that is a page of its own, not a snippet to paste into one. */
export const isWholePage = (code: string): boolean => /^\s*(<!doctype html|<html[\s>])/i.test(code)

/** Asks the server to make a file from text (see CONVERTED); resolves to the file, or throws with why not. */
export async function convertFile(name: string, source: FileSource, text: string): Promise<Blob> {
  const res = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, source, text }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Couldn't make ${name}.`)
  }
  return res.blob()
}

/** "chat-name-reply.md": a whole reply saved as Markdown. */
export function replyFileName(chatName: string): string {
  return exportFileName(chatName).replace(/\.md$/, '-reply.md')
}

/** Saves a fence's file: as it is, or made on the server first (a PDF from Markdown, say). */
export async function saveFile(file: FenceFile, text: string): Promise<void> {
  if (file.convert) downloadBlob(file.name, await convertFile(file.name, file.convert, text))
  else downloadText(file.name, text, file.type)
}

/** Types a browser tab can show by itself, so a file of one can be opened as well as saved. */
const VIEWABLE = new Set(['text/html', 'image/svg+xml', 'application/pdf', 'image/png'])
export const canOpen = (file: FenceFile): boolean => VIEWABLE.has(file.type)

/**
 * Shows a file in a new tab. The tab is opened at once, while the tap still
 * counts as one -- a browser blocks a window opened after a wait -- and
 * pointed at the file once it's made. Falls back to saving it.
 */
export async function openFile(file: FenceFile, text: string): Promise<void> {
  const tab = window.open('', '_blank')
  try {
    const blob = file.convert ? await convertFile(file.name, file.convert, text) : new Blob([text], { type: file.type })
    if (!tab) return downloadBlob(file.name, blob)
    const url = URL.createObjectURL(blob)
    tab.location.href = url
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err) {
    tab?.close()
    throw err
  }
}

/** The formats a whole reply can be saved in, from its Markdown. */
export const REPLY_FORMATS: { ext: string; label: string }[] = [
  { ext: 'md', label: 'Markdown' },
  { ext: 'pdf', label: 'PDF' },
  { ext: 'docx', label: 'Word' },
  { ext: 'html', label: 'Web page' },
]

/** A reply as a file in one of REPLY_FORMATS, named after its first heading ("meal-plan.pdf"), else reply.<ext>. */
export function replyFile(text: string, ext: string): FenceFile {
  // Named from the words, not a fence's opening line ("```html").
  const base = slugOf(text.replace(/```[\s\S]*?(```|$)/g, '')) || 'reply'
  const name = `${base}.${ext}`
  return ext === 'md' ? { name, type: 'text/markdown' } : { name, type: CONVERTED[ext]!.type, convert: 'markdown' }
}
