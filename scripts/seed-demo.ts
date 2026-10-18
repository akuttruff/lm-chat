import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../server/store.ts'
import { Memories } from '../server/memory.ts'
import type { Message } from '../src/types.ts'

/**
 * Fills the development database (.data-dev, the one `npm run dev` uses)
 * with demo chats so the app can be screenshotted: a chat with a tool call
 * that draws a chart, one with a table, one with code, and a few memories
 * in a memory file of its own. Run with `npm run seed:demo`, then start the
 * dev server pointed at that memory file:
 *
 *   MEMORY_DB=$PWD/.data-dev/memory.sqlite npm run dev
 *
 * It starts from an empty database every time and touches nothing real.
 */

const dir = path.resolve(process.cwd(), '.data-dev')
fs.rmSync(dir, { recursive: true, force: true })
const store = new Store({ dir })
store.setConfig({ lmStudioUrl: 'http://127.0.0.1:1234', model: 'qwen/qwen3.8-27b' })

const MODEL = 'qwen/qwen3.8-27b'
const stats = (input: number, output: number, reasoning: number, elapsed: number) => ({ inputTokens: input, outputTokens: output, reasoningTokens: reasoning, tokensPerSecond: Math.round((output / elapsed) * 10) / 10, firstTokenSeconds: 1.8 })
const user = (id: string, text: string): Message => ({ id, role: 'user', text })
const thinking = (id: string, text: string, elapsed: string): Message => ({ id, role: 'reasoning', text, elapsed })
const reply = (id: string, text: string, elapsed: number, input: number, output: number, reasoning: number): Message => ({ id, role: 'assistant', text, model: MODEL, instance: `${MODEL}:1`, elapsed: `${elapsed}s`, stats: stats(input, output, reasoning, elapsed) })

const chat = (name: string, messages: Message[], extra: { starred?: boolean; folderId?: string | null } = {}): string => {
  const c = store.create()
  store.setMessages(c.id, messages)
  store.patch(c.id, { name, ...extra })
  return c.id
}

const astrology = store.createFolder('Astrology')

chat('Weekly meal plan', [
  user('u1', 'Plan five weeknight dinners around chicken, salmon and tofu, about 600 kcal each, with a shopping list.'),
  thinking('r1', 'Five dinners, three proteins, roughly 600 kcal. Keep the sides simple and reuse ingredients so the shopping list stays short.', '3.1'),
  reply('a1', `Here is a week that reuses ingredients so the list stays short.

| Night | Dinner | About |
| --- | --- | --- |
| Mon | Sheet-pan chicken thighs, sweet potato, broccoli | 610 kcal |
| Tue | Salmon with brown rice and sesame greens | 590 kcal |
| Wed | Tofu and vegetable stir-fry over rice | 560 kcal |
| Thu | Chicken burrito bowls with black beans | 640 kcal |
| Fri | Miso salmon, soba, cucumber salad | 580 kcal |

**Shopping list**

- Chicken thighs (1 kg), salmon (4 fillets), firm tofu (2 blocks)
- Sweet potatoes, broccoli, bok choy, cucumbers, bell peppers, a lime
- Brown rice, soba noodles, black beans, salsa
- Soy sauce, miso, sesame oil, ginger, garlic

Want me to swap one night for something vegetarian besides the tofu?`, 24.6, 1320, 410, 95),
])

chat('Debounce in TypeScript', [
  user('u1', 'Write a typed debounce with a cancel method.'),
  reply('a1', `\`\`\`ts
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = (...args: A): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, waitMs)
  }
  debounced.cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return debounced
}
\`\`\`

The generic \`A\` keeps the arguments typed, and \`cancel\` clears the pending timer and nulls it so a second cancel is harmless.`, 11.2, 640, 210, 0),
], { folderId: null })

const transit = fs.readFileSync(path.resolve('src/test/fixtures/transit-chart.json'), 'utf8')
const todayId = chat('Transits today', [
  user('u1', 'What are my transits today?'),
  thinking('r1', 'The person wants today’s transits over the natal chart. Birth data is in memory: 1990-06-15 14:30, New York. Call create_transit_chart, then read the aspects by weight: Saturn on Mars is the backdrop, the Mercury contacts the day’s events.', '4.2'),
  {
    id: 't1', role: 'tool', name: 'create_transit_chart', plugin: 'mcp/astrology-v2',
    args: { date_time: '1990-06-15 14:30', city: 'New York', state: 'NY', country: 'USA' },
    output: transit,
    readings: {
      'Mercury|Conjunction|Pluto': 'A conversation that goes deeper than planned; one message drafted three times.',
      'Saturn|Conjunction|Mars': 'Effort rationed. A week past exact, still asking you to pace yourself.',
      'Mars|Opposition|True North Node': 'Yesterday’s argument about direction, cooling.',
      'Mercury|Trine|MC': 'What you say today is useful at work tomorrow.',
      'Mercury|Trine|Jupiter': 'A generous reading of the news; a mentor’s word lands.',
      'Uranus|Conjunction|Mercury': 'The long restlessness of mind: new tools, new names for old things.',
      'Mercury|Trine|Chiron': 'Talking about the old wound makes it a skill.',
      'Mercury|Sextile|Neptune': 'Daydreams with a thread of plan in them.',
    },
  },
  reply('a1', `### Today, October 13

The day belongs to **Mercury**. It sits on your natal **Pluto** this afternoon, exact at 14:42, the first of three passes: a conversation that goes deeper than planned, or a message you draft three times. By tomorrow morning the same Mercury trines your **Midheaven** and **Jupiter**, so what is said today finds its use at work.

**Saturn on your Mars** is a week past exact and still close. Energy is rationed; spend it on one thing. **Mars opposite your North Node** is separating too, so yesterday's argument about direction is already losing heat.

The Moon is in Scorpio in your second house all day, near transiting Mercury: feelings about money and worth are close to the surface. Nothing needs deciding.

*In one line:* say the true thing once, quietly, and go to bed early.`, 38.1, 7120, 910, 240),
  user('u2', 'Is Thursday any good for the hard conversation?'),
  reply('a2', `Thursday is better than today. By then Mercury has moved off your Pluto and is trining your Midheaven, so the conversation lands as clear rather than loaded. Avoid the afternoon of the 25th, when Mars squares your Pluto.`, 9.4, 7900, 160, 60),
], { starred: true, folderId: astrology.id })

store.setActive(todayId)

// Memories are written by the lm-memory MCP server in real use; here the table is made by hand, in a file of its own.
const memoryDb = new DatabaseSync(path.join(dir, 'memory.sqlite'))
memoryDb.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
const insert = memoryDb.prepare('INSERT INTO memories (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)')
;['Born June 15, 1990 at 14:30 in New York.', 'Prefers short answers with the reasoning shown.', 'Cooks on weeknights; no mushrooms.'].forEach((text, i) => insert.run(`demo-${i + 1}`, text, Date.now() - (3 - i) * 86_400_000, Date.now() - (3 - i) * 86_400_000))
memoryDb.close()
console.log(new Memories(path.join(dir, 'memory.sqlite')).list().length, 'memories')
console.log(`seeded ${dir}`)
