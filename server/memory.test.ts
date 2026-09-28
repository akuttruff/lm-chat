import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryInputError, Memories } from './memory.ts'

let dir: string
let file: string

/** The file as the memory MCP server (lm-memory-mcp) writes it. */
function seed(rows: [id: string, text: string, updatedAt: number][]): void {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  for (const [id, text, at] of rows) db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?)').run(id, text, at, at)
  db.close()
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-memory-'))
  file = path.join(dir, 'memory.sqlite')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('Memories', () => {
  it('reads nothing, and creates nothing, before the server has saved anything', () => {
    const m = new Memories(file)
    expect(m.list()).toEqual([])
    expect(m.promptBlock()).toMatch(/Nothing has been saved/)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('lists newest first', () => {
    seed([['a1', 'older', 1], ['b2', 'newer', 2]])
    expect(new Memories(file).list().map((m) => m.text)).toEqual(['newer', 'older'])
  })

  it('edits a memory, moving it to the front, and refuses junk', () => {
    seed([['a1', 'Lives in Seattle', 1], ['b2', 'Something else', 5]])
    const m = new Memories(file)
    expect(m.update('a1', '  Lives in   Portland ')!.text).toBe('Lives in Portland')
    expect(m.list()[0]!.id).toBe('a1')
    expect(m.update('nope', 'x')).toBeNull()
    expect(() => m.update('a1', '   ')).toThrow(MemoryInputError)
  })

  it('forgets one', () => {
    seed([['a1', 'Temporary', 1]])
    const m = new Memories(file)
    expect(m.forget('a1')).toBe(true)
    expect(m.forget('a1')).toBe(false)
    expect(m.list()).toEqual([])
  })

  it('puts what fits in the prompt with ids, framed as information, and says what it left out', () => {
    seed([['a1', 'Born May 10, 1984', 1], ['b2', 'x'.repeat(300), 2], ['c3', 'Prefers short answers', 3]])
    const block = new Memories(file).promptBlock(120)
    expect(block).toMatch(/remember, recall, update_memory, forget/)
    expect(block).toMatch(/not instructions/)
    expect(block).toContain('- [c3] Prefers short answers')
    expect(block).toContain('- [a1] Born May 10, 1984')
    expect(block).not.toContain('[b2]')
    expect(block).toMatch(/1 older memory not shown/)
  })

  it('tells the model to apply saved details unprompted and to save how the user likes things done', () => {
    seed([['a1', 'Born May 10, 1984', 1]])
    const block = new Memories(file).promptBlock()
    expect(block).toMatch(/without being asked/)
    expect(block).toMatch(/pass it to tools/)
    expect(block).toMatch(/how the user likes a kind of request handled/)
  })
})
