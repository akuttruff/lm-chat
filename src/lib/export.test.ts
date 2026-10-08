import { describe, it, expect } from 'vitest'
import { chatMarkdown, exportFileName, fenceFile, replyFileName } from './export.ts'

describe('chatMarkdown', () => {
  it('writes the chat out as Markdown: you and the replies in full, tools as notes, thinking left out', () => {
    const md = chatMarkdown({
      name: 'Transit questions', createdAt: Date.UTC(2026, 9, 5, 12),
      messages: [
        { id: '1', role: 'user', text: 'What is Jupiter doing?', images: [{ id: 'i', name: 'chart.png', mime: 'image/png', bytes: 1 }] },
        { id: '2', role: 'reasoning', text: 'hmm' },
        { id: '3', role: 'tool', name: 'create_transit_chart', args: { date_time: '2026-10-05 12:00' }, output: '...' },
        { id: '4', role: 'assistant', text: 'Jupiter **squares** your Sun.', model: 'qwen', instance: 'qwen/qwen3.8-27b' },
        { id: '5', role: 'error', text: 'oops' },
      ],
    }, new Date(Date.UTC(2026, 9, 6, 12)))
    expect(md).toContain('# Transit questions\n')
    expect(md).toContain('exported from LM Chat')
    expect(md).toContain('**You:**\n\n[image: chart.png]\n\nWhat is Jupiter doing?')
    expect(md).toContain('> 🔧 create transit chart — date_time: 2026-10-05 12:00')
    expect(md).toContain('**qwen/qwen3.8-27b:**\n\nJupiter **squares** your Sun.')
    expect(md).not.toContain('hmm')
    expect(md).not.toContain('oops')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('names the file after the chat', () => {
    expect(exportFileName('Transit questions: Oct 5!')).toBe('transit-questions-oct-5.md')
    expect(exportFileName('')).toBe('chat.md')
  })
})

describe('fenceFile', () => {
  it('names a Markdown block after its first heading, as .md', () => {
    expect(fenceFile('markdown', '# Weekly Meal Plan\n\n- oats')).toEqual({ name: 'weekly-meal-plan.md', type: 'text/markdown' })
    expect(fenceFile('md', 'Just some notes\nmore')).toEqual({ name: 'just-some-notes.md', type: 'text/markdown' })
    expect(fenceFile('markdown', '')).toEqual({ name: 'snippet.md', type: 'text/markdown' })
  })

  it('gives data and code blocks a plain name with the right extension', () => {
    expect(fenceFile('csv', 'a,b\n1,2')).toEqual({ name: 'snippet.csv', type: 'text/csv' })
    expect(fenceFile('json', '{}')).toEqual({ name: 'snippet.json', type: 'application/json' })
    expect(fenceFile('bash', 'ls')).toEqual({ name: 'snippet.sh', type: 'text/plain' })
  })

  it('takes a file name written after the language', () => {
    expect(fenceFile('markdown meal-plan.md', '# x')).toEqual({ name: 'meal-plan.md', type: 'text/markdown' })
    expect(fenceFile('text groceries.txt', 'eggs')).toEqual({ name: 'groceries.txt', type: 'text/plain' })
  })

  it('offers nothing for a bare fence or an unknown language', () => {
    expect(fenceFile(undefined, 'x')).toBeNull()
    expect(fenceFile('', 'x')).toBeNull()
    expect(fenceFile('mermaid', 'graph TD')).toBeNull()
  })

  it('names a saved reply after the chat', () => {
    expect(replyFileName('Transit questions')).toBe('transit-questions-reply.md')
  })
})
