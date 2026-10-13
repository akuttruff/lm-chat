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
  sql: { ext: 'sql', type: 'text/plain' }, toml: { ext: 'toml', type: 'text/plain' }, ini: { ext: 'ini', type: 'text/plain' },
}

/** "meal-plan": the first Markdown heading, or the first line, as a slug; empty when there is none. */
function slugOf(text: string): string {
  const heading = /^#{1,6}\s+(.+)$/m.exec(text)?.[1] ?? text.split('\n').find((l) => l.trim())?.replace(/^[\s#*>-]+/, '') ?? ''
  return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/**
 * What a fenced block would be saved as: a Markdown block headed "# Meal plan"
 * becomes meal-plan.md, a bare one snippet.md. A fence with a file name for
 * a language (```markdown meal-plan.md) is taken at its word. Blocks in
 * languages with no obvious file form -- or none -- are not offered.
 */
export function fenceFile(info: string | undefined, code: string): { name: string; type: string } | null {
  const [lang = '', ...rest] = (info ?? '').trim().split(/\s+/)
  const named = rest.find((w) => /^[\w.-]+\.[a-z0-9]{1,8}$/i.test(w))
  const known = FENCE_TYPES[lang.toLowerCase()]
  if (named) return { name: named, type: known?.type ?? 'text/plain' }
  if (!known) return null
  const base = known.ext === 'md' || known.ext === 'txt' ? slugOf(code) : ''
  return { name: `${base || 'snippet'}.${known.ext}`, type: known.type }
}

/** "chat-name-reply.md": a whole reply saved as Markdown. */
export function replyFileName(chatName: string): string {
  return exportFileName(chatName).replace(/\.md$/, '-reply.md')
}
