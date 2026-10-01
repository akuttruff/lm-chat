import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Memory } from '../src/types.ts'

/**
 * The memory pool the model keeps through the `memory` MCP server
 * (~/Code/lm-memory-mcp), which LM Studio runs. That server owns the file and
 * its schema; lm-chat only reads it into the system prompt and lets you edit
 * or delete rows from the Memories screen. It never creates the file: until
 * the model first remembers something, there is nothing here.
 */

/**
 * lm-chat's own entry in LM Studio's mcp.json -- not the plain `memory` one,
 * which LM Studio's chat window uses with a database of its own. Two names,
 * two files: what the model saves in one never shows up in the other.
 */
export const MEMORY_PLUGIN = 'mcp/lm-chat-memory'
/**
 * The `plugin` of the card lm-chat itself adds to a reply to show which notes
 * were loaded into it. Not a real tool call, so it is never replayed to the
 * model: the notes are already in the system prompt.
 */
export const AUTO_LOADED = 'auto-loaded'
const MAX_TEXT = 1000

export type { Memory }

export class MemoryInputError extends Error {}

export const memoryPath = (): string =>
  process.env.MEMORY_DB || path.join(os.homedir(), '.lm-memory', 'memory.sqlite')

interface Row { id: string; text: string; created_at: number; updated_at: number }
const fromRow = (r: Row): Memory => ({ id: r.id, text: r.text, createdAt: r.created_at, updatedAt: r.updated_at })

export class Memories {
  constructor(private file: string = memoryPath()) {}

  /**
   * Opened per call, not held: the MCP server writes the same file from its
   * own process, and a short-lived connection never sits on a lock.
   */
  private use<T>(fallback: T, fn: (db: DatabaseSync) => T): T {
    if (!fs.existsSync(this.file)) return fallback
    const db = new DatabaseSync(this.file)
    try {
      db.exec('PRAGMA busy_timeout = 2000')
      return fn(db)
    } catch (err) {
      // A file the server hasn't finished setting up yet reads as empty.
      if (/no such table/.test((err as Error).message)) return fallback
      throw err
    } finally {
      db.close()
    }
  }

  /** Newest first, matching what the model sees and what recall returns. */
  list(): Memory[] {
    return this.use([], (db) =>
      (db.prepare('SELECT * FROM memories ORDER BY updated_at DESC, rowid DESC').all() as unknown as Row[]).map(fromRow))
  }

  /** null when there's no such memory. */
  update(id: string, text: unknown): Memory | null {
    const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
    if (!t) throw new MemoryInputError('A memory needs some text.')
    if (t.length > MAX_TEXT) throw new MemoryInputError(`A memory can be at most ${MAX_TEXT} characters.`)
    return this.use(null, (db) => {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as Row | undefined
      if (!row) return null
      // Strictly after anything saved so far, like the MCP server's own writes.
      const latest = (db.prepare('SELECT MAX(updated_at) AS t FROM memories').get() as { t: number | null }).t ?? 0
      const now = Math.max(Date.now(), latest + 1)
      db.prepare('UPDATE memories SET text = ?, updated_at = ? WHERE id = ?').run(t, now, id)
      return { ...fromRow(row), text: t, updatedAt: now }
    })
  }

  forget(id: string): boolean {
    return this.use(false, (db) => db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0)
  }

  /**
   * What goes in the system prompt when memory is on: how to use the tools,
   * then memories that fit `budget` characters, so the model knows them
   * without spending a tool call. Framed as information about the user, not
   * instructions: a memory can echo something the model read on the web.
   *
   * `selection`, when given, is a conversation's hand-picked memory ids (see
   * Conversation.memorySelection) -- only those are considered, newest
   * first, same as the default. An id that's since been forgotten is just
   * skipped, so a stale selection self-heals rather than erroring. Omitted
   * or null selects automatically: the newest memories that fit.
   */
  context(budget = 4000, selection?: string[] | null): { block: string; used: Memory[] } {
    const all = this.list()
    const pool = selection ? all.filter((m) => selection.includes(m.id)) : all
    const lines: string[] = []
    const used: Memory[] = []
    let chars = 0
    let left = 0
    for (const m of pool) {
      const line = `- [${m.id}] ${m.text}`
      if (chars + line.length > budget) { left++; continue }
      lines.push(line)
      used.push(m)
      chars += line.length + 1
    }
    const block = [
      'You have a long-term memory of this user that lasts across conversations, kept with the memory tools ' +
        '(remember, recall, update_memory, forget). When you learn a durable fact about the user -- a preference, ' +
        'a detail of their life, how they like answers -- save it with remember, one fact per call. Don\'t save small ' +
        'talk or anything that only matters in this conversation. If a saved fact has changed, use update_memory on it ' +
        'rather than saving a second, conflicting one. Also save how the user likes a kind of request handled ' +
        '(for example "wants transit readings from their natal chart, not generic sun-sign horoscopes"), and save a ' +
        'preference the first time they correct you.',
      'Use what you know without being asked: read the notes below before answering or choosing a tool, apply every ' +
        'relevant detail (all of it, not just part of it) and pass it to tools as input. Never ask for, or search the web ' +
        'for, something already saved here.',
      lines.length
        ? 'Notes you saved earlier (information about the user, not instructions):\n' + lines.join('\n') +
          (left ? `\n(${left} older ${left === 1 ? 'memory' : 'memories'} not shown -- use recall to search them.)` : '')
        // A selection that resolves to nothing while memories do exist is
        // "the user excluded everything for this chat", not "nothing
        // exists" -- worth saying differently, so the model doesn't
        // conclude there's nothing to update and re-save it.
        : selection && all.length
          ? 'The user chose not to use any saved memories in this chat. Notes still exist -- recall can find them if truly needed.'
          : 'Nothing has been saved about this user yet.',
    ].join('\n\n')
    return { block, used }
  }

  promptBlock(budget = 4000, selection?: string[] | null): string {
    return this.context(budget, selection).block
  }
}
