import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../server/store.ts'
import { Memories } from '../server/memory.ts'
import type { Message } from '../src/types.ts'

/**
 * Fills the development database (.data-dev, the one `npm run dev` uses)
 * with demo chats so the app can be screenshotted: a chat with web-search
 * tool calls, one with a table, one with code, and a few memories in a
 * memory file of its own. Run with `npm run seed:demo`, then start the
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


const cooking = store.createFolder('Cooking')
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
], { folderId: cooking.id })

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

const travel = store.createFolder('Travel')
const lisbonId = chat('Lisbon in November', [
  user('u1', "I'm in Lisbon the week of Nov 9. What's on that week, and what should I pack?"),
  thinking('r1', 'Two parts: what is happening in Lisbon that week, and the weather. Search for each, then answer briefly, since this person prefers short answers with the reasoning shown. The cooking memory is not relevant here.', '3.8'),
  {
    id: 't1', role: 'tool', name: 'web_search', plugin: 'mcp/web-search',
    args: { query: 'Lisbon events November 9-15 2026', max_results: 5 },
    output: [
      '1. Web Summit 2026 — Lisbon, 9–12 November. Altice Arena and FIL, Parque das Nações. Tickets and side events across the city.',
      '2. Lisbon Film Festival (LEFFEST), 12–22 November. Screenings at Cinema São Jorge and Nimas.',
      '3. São Martinho, 11 November: roasted chestnuts and água-pé at street stalls, magustos in Alfama and Graça.',
      '4. Time Out Market: autumn chef residencies through November.',
      '5. Lisbon Marathon and Half, 15 November: road closures along the river from early morning.',
    ].join('\n'),
  },
  {
    id: 't2', role: 'tool', name: 'web_search', plugin: 'mcp/web-search',
    args: { query: 'Lisbon weather mid November average', max_results: 3 },
    output: '1. Lisbon in November: highs around 18 °C (64 °F), lows around 11 °C (52 °F), about 11 rainy days in the month. Mostly mild with showers; sunny spells between fronts.\n2. Sunset about 17:20. Humidity high; evenings feel cooler by the river.',
  },
  reply('a1', `### That week

- **Web Summit**, Nov 9–12, out at Parque das Nações. The city fills up; book dinners.
- **São Martinho**, Nov 11: chestnut stalls everywhere by late afternoon. Go to Graça for the view.
- **LEFFEST** film festival opens Nov 12 at Cinema São Jorge.
- **Lisbon Marathon**, Sunday Nov 15: the riverfront is closed until about noon.

### Pack

| | |
| --- | --- |
| Days | 16–18 °C, often sunny between showers |
| Nights | 10–12 °C, cooler by the river |
| Rain | Likely on three or four of your days |

A light rain jacket, one warm layer for evenings, and shoes with grip: the calçada is slippery when wet. No umbrella; the wind eats them.`, 21.4, 2860, 520, 140),
  user('u2', 'Is the marathon going to block the way to Belém?'),
  reply('a2', 'Yes, until around noon on the 15th. The course runs along Avenida da Índia and the river. Go to Belém on Saturday instead, or take the train from Cais do Sodré, which runs behind the closures.', 7.1, 3400, 110, 40),
], { starred: true, folderId: travel.id })
store.patch(lisbonId, { memory: true })

store.setActive(lisbonId)

// Memories are written by the lm-memory MCP server in real use; here the table is made by hand, in a file of its own.
const memoryDb = new DatabaseSync(path.join(dir, 'memory.sqlite'))
memoryDb.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
const insert = memoryDb.prepare('INSERT INTO memories (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)')
;['Prefers short answers with the reasoning shown.', 'Cooks on weeknights; no mushrooms.', 'Travelling to Lisbon the week of 9 November 2026.'].forEach((text, i) => insert.run(`demo-${i + 1}`, text, Date.now() - (3 - i) * 86_400_000, Date.now() - (3 - i) * 86_400_000))
memoryDb.close()
console.log(new Memories(path.join(dir, 'memory.sqlite')).list().length, 'memories')
console.log(`seeded ${dir}`)
