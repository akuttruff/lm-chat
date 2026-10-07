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
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
