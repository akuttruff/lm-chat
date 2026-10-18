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
    seed([['a1', 'Born June 15, 1990', 1], ['b2', 'x'.repeat(300), 2], ['c3', 'Prefers short answers', 3]])
    const block = new Memories(file).promptBlock(120)
    expect(block).toMatch(/remember, recall, update_memory, forget/)
    expect(block).toMatch(/not instructions/)
    expect(block).toContain('- [c3] Prefers short answers')
    expect(block).toContain('- [a1] Born June 15, 1990')
    expect(block).not.toContain('[b2]')
    expect(block).toMatch(/1 older memory not shown/)
  })

  it('tells the model to apply saved details unprompted and to save how the user likes things done', () => {
    seed([['a1', 'Born June 15, 1990', 1]])
    const block = new Memories(file).promptBlock()
    expect(block).toMatch(/without being asked/)
    expect(block).toMatch(/pass it to tools/)
    expect(block).toMatch(/how the user likes a kind of request handled/)
  })

  describe('a hand-picked selection', () => {
    beforeEach(() => {
      seed([['a1', 'Born June 15, 1990', 1], ['b2', 'Lives in Seattle', 2], ['c3', 'Prefers short answers', 3]])
    })

    it('includes only the chosen ids, newest first, ignoring the rest', () => {
      const { used, block } = new Memories(file).context(4000, ['b2', 'a1'])
      expect(used.map((m) => m.id)).toEqual(['b2', 'a1'])
      expect(block).toContain('[a1]')
      expect(block).toContain('[b2]')
      expect(block).not.toContain('[c3]')
    })

    it('skips an id that has since been forgotten, rather than erroring', () => {
      // Newest first, like automatic -- not the order ids were passed in.
      const { used } = new Memories(file).context(4000, ['a1', 'gone', 'c3'])
      expect(used.map((m) => m.id)).toEqual(['c3', 'a1'])
    })

    it('an empty selection means none, not automatic -- and says so distinctly from truly nothing saved', () => {
      const { used, block } = new Memories(file).context(4000, [])
      expect(used).toEqual([])
      expect(block).toMatch(/chose not to use any saved memories/)
      expect(block).not.toMatch(/Nothing has been saved/)
    })

    it('falls back to automatic (newest that fit) when null or omitted', () => {
      const auto = new Memories(file).context()
      const explicitNull = new Memories(file).context(4000, null)
      expect(auto.used.map((m) => m.id)).toEqual(['c3', 'b2', 'a1'])
      expect(explicitNull.used.map((m) => m.id)).toEqual(auto.used.map((m) => m.id))
    })
  })
})
