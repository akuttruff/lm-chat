import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Bus } from './bus.ts'
import {
  Engine, formatToolOutput, parseIntegrations, buildHistoryPrompt, planCompaction, planFullCompaction, summarizerInput, wholeSentences,
  summaryTokenCap, newEngineState, cleanTitle, DATE_NOTE, toolArgs,
} from './engine.ts'
import { Store } from './store.ts'
import { Memories } from './memory.ts'
import { DatabaseSync } from 'node:sqlite'
import type { ImageUpload, Message, ServerConfig } from '../src/types.ts'

let dir: string
let store: Store
let bus: Bus
let engine: Engine
let convId: string

/** An SSE `data:` frame, the shape LM Studio emits. */
const evt = (obj: Record<string, unknown>): string => `data: ${JSON.stringify(obj)}\n\n`

/** A fetch stand-in that streams the given frames. */
function streams(frames: string[], { status = 200 } = {}) {
  const enc = new TextEncoder()
  return vi.fn(() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(''),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f))
        controller.close()
      },
    }),
  }))
}

// Auto-titling is off here unless a test turns it on: it makes a second
// request after the first reply, which the tests of the reply itself don't
// expect to see.
function configure(patch: Partial<ServerConfig>): void {
  store.setConfig({ model: 'qwen', apiToken: 'sk-lm-TOKEN', autoTitle: 'off', ...patch })
}

const messages = (): Message[] => store.get(convId)!.messages
const bodyOf = (f: { mock: { calls: unknown[][] } }): Record<string, unknown> =>
  JSON.parse(String(((f.mock.calls[0]![1]) as RequestInit).body)) as Record<string, unknown>

beforeEach(() => {
  vi.unstubAllGlobals()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-engine-'))
  store = new Store({ dir })
  bus = new Bus()
  engine = new Engine(store, bus, () => Promise.resolve(null))
  convId = store.getConversations().activeId!
  configure({})
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('formatToolOutput', () => {
  it("unwraps LM Studio's content envelope", () => {
    expect(formatToolOutput(JSON.stringify([{ type: 'text', text: 'Friday, September 25' }])))
      .toBe('Friday, September 25')
  })
  it('joins multiple parts', () => {
    expect(formatToolOutput([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]))
      .toBe('one\ntwo')
  })
  it('passes plain strings through', () => {
    expect(formatToolOutput('just text')).toBe('just text')
  })
  it('leaves malformed JSON alone', () => {
    expect(formatToolOutput('[{broken')).toBe('[{broken')
  })
  it('renders nullish as empty', () => {
    expect(formatToolOutput(null)).toBe('')
    expect(formatToolOutput(undefined)).toBe('')
  })
})

describe('parseIntegrations', () => {
  it('qualifies bare labels and drops blanks', () => {
    expect(parseIntegrations('astrology, mcp/deep-research, , ')).toEqual([
      { type: 'plugin', id: 'mcp/astrology' },
      { type: 'plugin', id: 'mcp/deep-research' },
    ])
  })
  it('returns nothing for an empty field', () => {
    expect(parseIntegrations('')).toEqual([])
  })

})

describe('request body', () => {
  it('refuses to call LM Studio with no model chosen', async () => {
    configure({ model: '' })
    const f = streams([])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    expect(f).not.toHaveBeenCalled()
    expect(messages().at(-1)!.role).toBe('error')
  })

  it('tells the model when each message was sent, without changing what is saved', async () => {
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'What day is it?')
    const sent = String(bodyOf(f).input)
    // e.g. "What day is it?\n\n[Sent Wednesday, October 1, 2026 at 12:34 AM PDT]"
    expect(sent).toMatch(/^What day is it\?\n\n\[Sent \w+day, \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M [A-Z]{2,5}\]$/)
    expect(messages().at(-1)!.text).toBe('What day is it?')
    // The stamp rides on the new message only: the system prompt explains
    // it (DATE_NOTE) but never carries one, so the cached prefix stays put.
    expect(String(bodyOf(f).system_prompt ?? '')).not.toMatch(/\[Sent \w+day,/)
  })

  it('omits context_length so LM Studio reuses the loaded instance', async () => {
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    expect(bodyOf(f)).not.toHaveProperty('context_length')
  })

  it('sends context_length only when configured', async () => {
    configure({ contextLength: '8000' })
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    expect(bodyOf(f).context_length).toBe(8000)
  })

  it('sends the API token the server holds', async () => {
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-lm-TOKEN')
  })

  it('sends the system prompt alone on a fresh thread', async () => {
    configure({ systemPrompt: 'be terse' })
    const first = streams([evt({ type: 'chat.end', result: { response_id: 'resp_1' } })])
    vi.stubGlobal('fetch', first)
    await engine.runTurn(convId, 'hi')
    // Nothing has been said yet, so there is no transcript to append -- just
    // the fixed note explaining the date stamp, then the Settings prompt.
    expect(bodyOf(first).system_prompt).toBe(`${DATE_NOTE}\n\nbe terse`)
  })

  it('fits a saved reasoning level to what the model accepts', async () => {
    engine = new Engine(store, bus, () => Promise.resolve({ allowed: ['off', 'on'], default: 'on' }))
    store.patch(convId, { reasoning: 'medium' })
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    expect(bodyOf(f).reasoning).toBe('on')
  })

  it('summarizes with reasoning off when the model allows it', async () => {
    engine = new Engine(store, bus, () => Promise.resolve({ allowed: ['off', 'on'], default: 'on' }))
    configure({ historyChars: '2000' })
    store.setMessages(convId, Array.from({ length: 20 }, (_, i): Message =>
      ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ${'z'.repeat(200)}` })))
    const f = streams([evt({ type: 'message.delta', content: 'summary' }), evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'q')
    const summarize = JSON.parse(String(((f.mock.calls as unknown[][])[1]![1] as RequestInit).body)) as Record<string, unknown>
    expect(summarize.reasoning).toBe('off')
  })

  it('prefers the per-chat reasoning level over the default', async () => {
    configure({ reasoning: 'low' })
    store.patch(convId, { reasoning: 'xhigh' })
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    expect(bodyOf(f).reasoning).toBe('xhigh')
  })

  it('includes MCP integrations when configured', async () => {
    configure({ mcpTools: 'mcp/astrology' })
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'hi')
    expect(bodyOf(f).integrations).toEqual([{ type: 'plugin', id: 'mcp/astrology' }])
  })
})

describe('streaming', () => {
  it('accumulates deltas into one message and persists it', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.delta', content: 'Hel' }),
      evt({ type: 'message.delta', content: 'lo' }),
      evt({ type: 'chat.end', result: { response_id: 'r9' } }),
    ]))
    await engine.runTurn(convId, 'hi')
    const assistant = messages().filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.text).toBe('Hello')
    expect(assistant[0]!.streaming).toBe(false)
    expect(store.get(convId)!.responseId).toBe('r9')

    // Durable, not just in memory.
    const reopened = new Store({ dir }).get(convId)!.messages
    expect(reopened.some((m) => m.text === 'Hello')).toBe(true)
  })

  it('handles frames split across chunk boundaries', async () => {
    vi.stubGlobal('fetch', streams([
      'data: {"type":"message.delta","con',
      'tent":"split"}\n\n',
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().find((m) => m.role === 'assistant')!.text).toBe('split')
  })

  it('tolerates CRLF line endings', async () => {
    vi.stubGlobal('fetch', streams([
      `data: ${JSON.stringify({ type: 'message.delta', content: 'crlf' })}\r\n\r\n`,
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().find((m) => m.role === 'assistant')!.text).toBe('crlf')
  })

  it('keeps the whole tool result, not a display-sized clip', async () => {
    // A follow-up question usually depends on what the tool actually returned.
    const chart = JSON.stringify([{ type: 'text', text: 'x'.repeat(20000) }])
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 'mcp/astrology' }),
      evt({ type: 'tool_call.success', output: chart }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    // A year of transits is ~20KB; it must survive whole.
    expect(messages().find((m) => m.role === 'tool')!.output).toHaveLength(20000)
  })

  it('records tool calls with readable output', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 'mcp/astrology' }),
      evt({ type: 'tool_call.success', output: JSON.stringify([{ type: 'text', text: 'chart data' }]) }),
      evt({ type: 'message.delta', content: 'done' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    const tool = messages().find((m) => m.role === 'tool')!
    expect(tool.name).toBe('mcp/astrology')
    expect(tool.output).toBe('chart data')
    expect(tool.failed).toBe(false)
  })

  it('keeps the results of calls made at once with their own calls, whatever order they return in', async () => {
    const text = (t: string) => JSON.stringify([{ type: 'text', text: t }])
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start' }),
      evt({ type: 'tool_call.name', tool_name: 'create_transit_chart', provider_info: { plugin_id: 'mcp/astrology-v2' } }),
      evt({ type: 'tool_call.arguments', tool_name: 'create_transit_chart', arguments: { city: 'New York' } }),
      evt({ type: 'tool_call.start' }),
      evt({ type: 'tool_call.name', tool_name: 'list_upcoming_transits', provider_info: { plugin_id: 'mcp/astrology-v2' } }),
      evt({ type: 'tool_call.arguments', tool_name: 'list_upcoming_transits', arguments: { days: 7 } }),
      // The list answers first, by name; then the chart, by its parameters.
      evt({ type: 'tool_call.success', tool_name: 'list_upcoming_transits', output: text('the list') }),
      evt({ type: 'tool_call.success', arguments: { city: 'New York' }, output: text('the chart') }),
      evt({ type: 'message.delta', content: 'done' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    const tools = messages().filter((m) => m.role === 'tool')
    expect(tools.map((m) => [m.name, m.output])).toEqual([['create_transit_chart', 'the chart'], ['list_upcoming_transits', 'the list']])
  })

  it('gives unlabelled results to the calls still waiting, oldest first, and a failure the same way', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 'a' }),
      evt({ type: 'tool_call.start', tool: 'b' }),
      evt({ type: 'tool_call.start', tool: 'c' }),
      evt({ type: 'tool_call.success', output: 'first' }),
      evt({ type: 'tool_call.failure', reason: 'broke' }),
      evt({ type: 'tool_call.success', output: 'third' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    const tools = messages().filter((m) => m.role === 'tool')
    expect(tools.map((m) => [m.name, m.output, m.failed])).toEqual([['a', 'first', false], ['b', 'broke', true], ['c', 'third', false]])
  })

  it('marks a failed tool call', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 'mcp/x' }),
      evt({ type: 'tool_call.failure', reason: 'timed out' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().find((m) => m.role === 'tool')).toMatchObject({ failed: true, output: 'timed out' })
  })

  it('captures reasoning separately from the answer', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'reasoning.delta', content: 'thinking hard' }),
      evt({ type: 'reasoning.end' }),
      evt({ type: 'message.delta', content: 'the answer' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().map((m) => m.role)).toEqual(['user', 'reasoning', 'assistant'])
    expect(messages().find((m) => m.role === 'reasoning')!.text).toBe('thinking hard')
  })

  it('leaves no empty bubble when the model goes straight to a tool', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.start' }),
      evt({ type: 'tool_call.start', tool: 't' }),
      evt({ type: 'tool_call.success', output: 'data' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(messages().map((m) => m.role)).toEqual(['user', 'tool'])
  })

  it('treats a whitespace-only reply as empty', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 't' }),
      evt({ type: 'tool_call.success', output: 'data' }),
      evt({ type: 'message.delta', content: '\n' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().filter((m) => m.role === 'assistant')).toHaveLength(0)
  })

  it('names the thread from the first message', async () => {
    vi.stubGlobal('fetch', streams([evt({ type: 'chat.end', result: {} })]))
    await engine.runTurn(convId, 'What is my forecast today?')
    expect(store.get(convId)!.name).toBe('What is my forecast today?')
  })

  it('keeps earlier messages when replying again', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.delta', content: 'first' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'one')
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.delta', content: 'second' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'two')
    expect(messages().map((m) => m.text)).toEqual(['one', 'first', 'two', 'second'])
  })
})

describe('failures', () => {
  it('reports an auth failure without blaming the network', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: { message: 'Invalid LM Studio API token' } })),
    })))
    await engine.runTurn(convId, 'hi')
    const err = messages().at(-1)!
    expect(err.role).toBe('error')
    expect(err.text).toMatch(/Invalid LM Studio API token/)
  })

  it('reports an unreachable server', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('fetch failed'))))
    await engine.runTurn(convId, 'hi')
    expect(messages().at(-1)!.text).toMatch(/Couldn't reach LM Studio/)
  })

  it('treats a stream that ends without chat.end as cut short, keeping what arrived', async () => {
    // LM Studio's MCP tool timeout: it logs the error and closes the stream
    // with no error frame, right after the tool_call.arguments packet.
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.start' }),
      evt({ type: 'message.delta', content: 'Let me check.' }),
      evt({ type: 'message.end' }),
      evt({ type: 'tool_call.start', tool: 't1' }),
      evt({ type: 'tool_call.name', tool: 't1', tool_name: 'list_upcoming_transits', provider_info: { plugin_id: 'mcp/astrology-v2' } }),
    ]))
    await engine.runTurn(convId, 'When are the Pluto squares?')
    const last = messages().at(-1)!
    expect(last.role).toBe('error')
    expect(last.text).toMatch(/closed the connection before the reply finished/)
    expect(last.text).toMatch(/60-second limit/)
    expect(last.text).toMatch(/plugin process had died/)
    expect(messages().some((m) => m.role === 'assistant' && m.text === 'Let me check.')).toBe(true)
    expect(messages().some((m) => m.role === 'tool' && m.name === 'list_upcoming_transits')).toBe(true)
  })

  it('surfaces an error frame', async () => {
    vi.stubGlobal('fetch', streams([evt({ type: 'error', error: { message: 'model exploded' } })]))
    await engine.runTurn(convId, 'hi')
    expect(messages().at(-1)!.text).toMatch(/model exploded/)
  })

  it('keeps partial output when the stream breaks mid-reply', async () => {
    const enc = new TextEncoder()
    let delivered = false
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      // Deliver on one pull and fail on the next: controller.error()
      // discards anything still queued, so erroring in the same tick would
      // mean the frame never arrives at all.
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) return controller.error(new TypeError('connection reset'))
          delivered = true
          controller.enqueue(enc.encode(evt({ type: 'message.delta', content: 'half' })))
        },
      }),
    })))
    await engine.runTurn(convId, 'hi')
    expect(messages().some((m) => m.text === 'half')).toBe(true)
    expect(messages().at(-1)!.text).toMatch(/cut short/)
  })

  it('stops on request, keeping what streamed', async () => {
    const enc = new TextEncoder()
    let fire: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => Promise.resolve({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(evt({ type: 'message.delta', content: 'partial' })))
          fire = () => controller.error(init.signal?.reason as Error)
          init.signal?.addEventListener('abort', () => fire?.())
        },
      }),
    })))
    const turn = engine.runTurn(convId, 'hi')
    await vi.waitFor(() => expect(messages().some((m) => m.text === 'partial')).toBe(true))
    engine.stop(convId)
    await turn
    expect(messages().some((m) => m.text === 'partial')).toBe(true)
    expect(messages().at(-1)!.text).toBe('Stopped.')
  })

  it('refuses a second turn while one is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => { /* never settles */ })))
    void engine.runTurn(convId, 'first')
    await vi.waitFor(() => expect(engine.isRunning(convId)).toBe(true))
    await expect(engine.runTurn(convId, 'second')).rejects.toThrow(/already in flight/)
  })
})

describe('memory', () => {
  let memDir: string
  let memoryEngine: Engine
  let remember: (id: string, text: string, at: number) => void
  beforeEach(() => {
    memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-chat-engine-memory-'))
    const file = path.join(memDir, 'memory.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    db.prepare('INSERT INTO memories VALUES (?, ?, ?, ?)').run('a1', 'Favorite color is green', 1, 1)
    db.close()
    remember = (id: string, text: string, at: number) => {
      const d = new DatabaseSync(file)
      d.prepare('INSERT INTO memories VALUES (?, ?, ?, ?)').run(id, text, at, at)
      d.close()
    }
    memoryEngine = new Engine(store, bus, () => Promise.resolve(null), newEngineState(), new Memories(file))
  })
  afterEach(() => fs.rmSync(memDir, { recursive: true, force: true }))

  const turn = async (): Promise<Record<string, unknown>> => {
    const f = streams([evt({ type: 'message.delta', content: 'ok' }), evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await memoryEngine.runTurn(convId, 'hi')
    return bodyOf(f)
  }
  const plugins = (body: Record<string, unknown>): string[] =>
    ((body.integrations ?? []) as { id: string }[]).map((i) => i.id)

  it('is off by default: no memory tools, nothing remembered in the prompt', async () => {
    const body = await turn()
    expect(plugins(body)).not.toContain('mcp/lm-chat-memory')
    expect(String(body.system_prompt ?? '')).not.toMatch(/green/)
  })

  it('when on, gives the model the memory tools and what it has saved', async () => {
    configure({ memoryDefault: 'on', systemPrompt: 'Be kind.' })
    const body = await turn()
    expect(plugins(body)).toContain('mcp/lm-chat-memory')
    expect(String(body.system_prompt).startsWith(DATE_NOTE)).toBe(true)
    expect(String(body.system_prompt)).toMatch(/\n\nBe kind\.[\s\S]*\[a1\] Favorite color is green/)
  })

  it('lets a chat turn it off even when the default is on, and on when it is off', async () => {
    configure({ memoryDefault: 'on' })
    store.patch(convId, { memory: false })
    expect(plugins(await turn())).not.toContain('mcp/lm-chat-memory')
    configure({ memoryDefault: 'off' })
    store.patch(convId, { memory: true })
    expect(plugins(await turn())).toContain('mcp/lm-chat-memory')
  })

  it("a chat in a folder takes the folder's memory switch over Settings', and its own over the folder's", async () => {
    configure({ memoryDefault: 'off' })
    const folder = store.createFolder('Personal')
    store.updateFolder(folder.id, { memory: true })
    store.patch(convId, { folderId: folder.id })
    expect(plugins(await turn())).toContain('mcp/lm-chat-memory')
    store.patch(convId, { memory: false })
    expect(plugins(await turn())).not.toContain('mcp/lm-chat-memory')
    store.patch(convId, { memory: null })
    store.updateFolder(folder.id, { memory: null }) // back to Settings
    expect(plugins(await turn())).not.toContain('mcp/lm-chat-memory')
  })

  it("a folder's memory pick limits its chats' prompt, until a chat picks for itself", async () => {
    remember('b2', 'Lives in Seattle', 2)
    configure({ memoryDefault: 'on' })
    const folder = store.createFolder('Travel')
    store.updateFolder(folder.id, { memorySelection: ['b2'] })
    store.patch(convId, { folderId: folder.id })
    let body = await turn()
    expect(String(body.system_prompt)).toMatch(/\[b2\] Lives in Seattle/)
    expect(String(body.system_prompt)).not.toMatch(/Favorite color is green/)
    store.patch(convId, { memorySelection: ['a1'] }) // the chat's own pick wins
    body = await turn()
    expect(String(body.system_prompt)).toMatch(/Favorite color is green/)
    expect(String(body.system_prompt)).not.toMatch(/Lives in Seattle/)
  })

  it('shows which memories were loaded as a card before the reply, without a tool call', async () => {
    configure({ memoryDefault: 'on' })
    await turn()
    const card = messages().find((m) => m.role === 'tool')!
    expect(card).toMatchObject({ name: 'memory', plugin: 'auto-loaded', failed: false })
    expect(card.output).toMatch(/1 memory loaded into this reply:\n- Favorite color is green/)
    expect(messages().map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
  })

  it('limits the prompt and the card to a chat\'s hand-picked memories, ignoring the rest', async () => {
    remember('b2', 'Lives in Seattle', 2)
    configure({ memoryDefault: 'on' })
    store.patch(convId, { memorySelection: ['b2'] })
    const body = await turn()
    expect(String(body.system_prompt)).toMatch(/\[b2\] Lives in Seattle/)
    expect(String(body.system_prompt)).not.toMatch(/Favorite color is green/)
    const card = messages().find((m) => m.role === 'tool')!
    expect(card.output).toMatch(/1 memory loaded into this reply:\n- Lives in Seattle/)
  })

  it('an empty selection loads nothing, distinct from automatic', async () => {
    remember('b2', 'Lives in Seattle', 2)
    configure({ memoryDefault: 'on' })
    store.patch(convId, { memorySelection: [] })
    const body = await turn()
    expect(String(body.system_prompt)).toMatch(/chose not to use any saved memories/)
    expect(messages().some((m) => m.role === 'tool')).toBe(false)
  })

  it('shows no card with memory off, or when nothing has been saved yet', async () => {
    await turn()
    expect(messages().some((m) => m.role === 'tool')).toBe(false)
    configure({ memoryDefault: 'on' })
    memoryEngine = new Engine(store, bus, () => Promise.resolve(null), newEngineState(), new Memories(path.join(memDir, 'none.sqlite')))
    store.patch(convId, { memory: true })
    await turn()
    expect(messages().some((m) => m.role === 'tool')).toBe(false)
  })

  it('does not send the card back to the model on the next turn', async () => {
    configure({ memoryDefault: 'on' })
    await turn()
    const body = await turn()
    expect(String(body.system_prompt)).not.toMatch(/loaded into this reply/)
    expect(String(body.system_prompt)).not.toMatch(/Tool memory returned/)
  })

  it('does not list the memory server twice when Settings already names it', async () => {
    configure({ memoryDefault: 'on', mcpTools: 'mcp/lm-chat-memory, deep-research' })
    expect(plugins(await turn())).toEqual(['mcp/deep-research', 'mcp/lm-chat-memory'])
  })

  it('turns memory off for a chat even when Settings still lists it as a general tool', async () => {
    // Regression: memory was left in mcpTools from before the per-chat
    // toggle existed. The old code only ever added mcp/memory, never
    // removed it, so it was in every chat's integrations no matter what
    // the toggle said -- this is what that looked like.
    configure({ memoryDefault: 'on', mcpTools: 'mcp/lm-chat-memory, deep-research' })
    store.patch(convId, { memory: false })
    expect(plugins(await turn())).toEqual(['mcp/deep-research'])
  })
})

describe('retrying the last message', () => {
  const reply = (text: string) => streams([
    evt({ type: 'message.delta', content: text }), evt({ type: 'chat.end', result: {} }),
  ])

  it('replaces a failed reply with a fresh one, without sending the message twice', async () => {
    vi.stubGlobal('fetch', streams([evt({ type: 'error', error: { message: 'model exploded' } })]))
    await engine.runTurn(convId, 'what is my forecast?')
    expect(messages().at(-1)!.role).toBe('error')

    const fetchAgain = reply('Sunny.')
    vi.stubGlobal('fetch', fetchAgain)
    await engine.retryTurn(convId)

    expect(messages().map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages()[0]!.text).toBe('what is my forecast?')
    expect(messages()[1]!.text).toBe('Sunny.')
    // The model is asked the same thing once, as the message -- not as prior history too.
    expect(String(bodyOf(fetchAgain).input)).toMatch(/^what is my forecast\?\n\n\[Sent /)
    expect(String(bodyOf(fetchAgain).system_prompt ?? '')).not.toMatch(/what is my forecast\?/)
  })

  it('drops a partial reply and its tool calls too, keeping earlier turns', async () => {
    vi.stubGlobal('fetch', reply('First answer.'))
    await engine.runTurn(convId, 'one')
    vi.stubGlobal('fetch', reply('Second answer.'))
    await engine.runTurn(convId, 'two')

    vi.stubGlobal('fetch', reply('Better second answer.'))
    await engine.retryTurn(convId)
    expect(messages().map((m) => m.text)).toEqual(['one', 'First answer.', 'two', 'Better second answer.'])
  })

  it("tells clients to replace everything from the retried message on", async () => {
    vi.stubGlobal('fetch', reply('First answer.'))
    await engine.runTurn(convId, 'one')
    const sent: { type: string; payload: { base?: number } }[] = []
    bus.add({ write: (chunk: string) => { sent.push(JSON.parse(chunk.replace(/^data: /, ''))); return true } } as never)
    vi.stubGlobal('fetch', reply('Again.'))
    await engine.retryTurn(convId)
    const tails = sent.filter((e) => e.type === 'tail').map((e) => e.payload as { base: number; messages: Message[] })
    expect(tails.length).toBeGreaterThan(0)
    // The message retried stays as it was; everything after it goes, and the old reply is never sent again.
    expect(tails.some((t) => t.base <= 1)).toBe(true)
    expect(tails.flatMap((t) => t.messages).some((m) => m.text === 'First answer.')).toBe(false)
    let held = new Store({ dir }).get(convId)!.messages.slice(0, 2)
    held = [{ ...held[0]! }, { id: 'old', role: 'assistant', text: 'First answer.' }]
    for (const t of tails) held = [...held.slice(0, t.base), ...t.messages]
    expect(held.map((m) => m.text)).toEqual(['one', 'Again.'])
  })

  it('has nothing to retry in a chat with no message sent', async () => {
    await expect(engine.retryTurn(convId)).rejects.toThrow(/nothing to retry/)
  })

  it('will not start while a reply is already in flight', async () => {
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { release = () => resolve({ ok: false, status: 500, text: () => Promise.resolve('') }) })))
    const running = engine.runTurn(convId, 'hi')
    await expect(engine.retryTurn(convId)).rejects.toThrow(/already in flight/)
    release?.()
    await running
  })
})

describe('tool naming, as LM Studio actually emits it', () => {
  /**
   * Captured from a real session. Note that `tool_call.start` carries no
   * name at all -- the docs claim a `tool` field, but the name arrives in
   * the `tool_call.name` event that follows, as `tool_name`.
   */
  const REAL_SEQUENCE = [
    evt({ type: 'tool_call.start' }),
    evt({
      type: 'tool_call.name',
      tool_name: 'create_transit_chart',
      provider_info: { type: 'plugin', plugin_id: 'mcp/astrology-v2' },
    }),
    evt({
      type: 'tool_call.arguments',
      tool: 'create_transit_chart',
      provider_info: { type: 'plugin', plugin_id: 'mcp/astrology-v2' },
      arguments: { date_time: '2000-01-01 12:00' },
    }),
    evt({ type: 'tool_call.success', output: 'chart data' }),
    evt({ type: 'chat.end', result: {} }),
  ]

  it('names the tool from tool_call.name', async () => {
    vi.stubGlobal('fetch', streams(REAL_SEQUENCE))
    await engine.runTurn(convId, 'my chart?')
    const tool = messages().find((m) => m.role === 'tool')!
    expect(tool.name).toBe('create_transit_chart')
    expect(tool.plugin).toBe('mcp/astrology-v2')
  })

  it('keeps the parameters the tool was called with, and survives a reload', async () => {
    vi.stubGlobal('fetch', streams(REAL_SEQUENCE))
    await engine.runTurn(convId, 'my chart?')
    expect(messages().find((m) => m.role === 'tool')!.args).toEqual({ date_time: '2000-01-01 12:00' })
  })

  it('cuts down parameters too long to read, keeping every name', () => {
    const args = toolArgs({ query: 'q', notes: 'n'.repeat(20000) })!
    expect(args.query).toBe('q')
    expect(String(args.notes)).toMatch(/^n+… \(20000 characters\)$/)
    expect(JSON.stringify(args).length).toBeLessThan(10000)
    expect(toolArgs('not an object')).toBeUndefined()
    expect(toolArgs([1, 2])).toBeUndefined()
  })

  it('records which MCP server provided it', async () => {
    vi.stubGlobal('fetch', streams(REAL_SEQUENCE))
    await engine.runTurn(convId, 'my chart?')
    expect(messages().find((m) => m.role === 'tool')!.plugin).toBe('mcp/astrology-v2')
  })

  it('still works if only tool_call.arguments carries the name', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start' }),
      evt({ type: 'tool_call.arguments', tool: 'get_current_datetime' }),
      evt({ type: 'tool_call.success', output: 'Friday' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'date?')
    expect(messages().find((m) => m.role === 'tool')!.name).toBe('get_current_datetime')
  })

  it('falls back to the name on tool_call.success', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start' }),
      evt({ type: 'tool_call.success', tool_name: 'late_name', output: 'x' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().find((m) => m.role === 'tool')!.name).toBe('late_name')
  })

  it('still honours a name on tool_call.start, should a version send one', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 'from_start' }),
      evt({ type: 'tool_call.success', output: 'x' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().find((m) => m.role === 'tool')!.name).toBe('from_start')
  })

  it('names a failed call too', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start' }),
      evt({ type: 'tool_call.name', tool_name: 'create_natal_chart' }),
      evt({ type: 'tool_call.failure', reason: 'timed out' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'hi')
    const tool = messages().find((m) => m.role === 'tool')!
    expect(tool.name).toBe('create_natal_chart')
    expect(tool.failed).toBe(true)
  })
})

describe('conversation context', () => {
  const assistant = (text: string, responseId?: string): Message =>
    ({ id: text, role: 'assistant', text, ...(responseId ? { responseId } : {}) })
  const user = (text: string): Message => ({ id: text, role: 'user', text })

  describe('buildHistoryPrompt', () => {
    it('replays prior turns in order', () => {
      const prompt = buildHistoryPrompt('be terse', [
        user('what is my sign?'), assistant('Sagittarius rising'), user('and tomorrow?'),
      ], 24000)!
      expect(prompt).toMatch(/be terse/)
      expect(prompt.indexOf('User: what is my sign?')).toBeLessThan(prompt.indexOf('Assistant: Sagittarius rising'))
      // The current turn goes in `input`, not the transcript.
      expect(prompt).not.toMatch(/and tomorrow/)
    })

    it('is just the system prompt on a fresh thread', () => {
      expect(buildHistoryPrompt('be terse', [user('first')], 24000)).toBe('be terse')
    })

    it('returns nothing when there is neither prompt nor history', () => {
      expect(buildHistoryPrompt('', [user('first')], 24000)).toBeUndefined()
    })

    it('keeps the most recent turns when trimming', () => {
      const long = Array.from({ length: 400 }, (_, i) => assistant(`reply ${i} ${'x'.repeat(80)}`))
      const prompt = buildHistoryPrompt('', [...long, user('now')], 8000)!
      expect(prompt.length).toBeLessThan(9000)
      expect(prompt).toMatch(/context:\n\n\.\.\./)
      expect(prompt).toMatch(/reply 399/)
      expect(prompt).not.toMatch(/reply 0 /)
    })

    it('replays everything when the limit is 0', () => {
      const long = Array.from({ length: 200 }, (_, i) => assistant(`reply ${i}`))
      const prompt = buildHistoryPrompt('', [...long, user('now')], 0)!
      expect(prompt).toMatch(/reply 0/)
      expect(prompt).toMatch(/reply 199/)
    })

    it('includes tool results, which later turns refer back to', () => {
      const prompt = buildHistoryPrompt('', [
        user('what is my chart?'),
        { id: 't', role: 'tool', name: 'mcp/astrology', output: 'Sun in Libra, Asc Sagittarius' },
        assistant('Here is your chart'),
        user('what about my rising sign?'),
      ], 24000)!
      expect(prompt).toMatch(/Tool mcp\/astrology returned: Sun in Libra, Asc Sagittarius/)
    })

    it('marks a failed tool as failed', () => {
      const prompt = buildHistoryPrompt('', [
        user('q'),
        { id: 't', role: 'tool', name: 'mcp/x', output: 'timed out', failed: true },
        user('follow-up'),
      ], 24000)!
      expect(prompt).toMatch(/Tool mcp\/x failed: timed out/)
    })

    it('still skips error messages, which are ours rather than the model\'s', () => {
      const prompt = buildHistoryPrompt('', [
        user('q'),
        { id: 'e', role: 'error', text: 'Stopped.' },
        user('follow-up'),
      ], 24000)!
      // Our own failure notices are not part of the conversation.
      expect(prompt).toMatch(/User: q/)
      expect(prompt).not.toMatch(/Stopped/)
    })

    it('skips a tool call that returned nothing', () => {
      const prompt = buildHistoryPrompt('', [
        user('q'),
        { id: 't', role: 'tool', name: 'mcp/x', output: '' },
        user('follow-up'),
      ], 24000)!
      expect(prompt).not.toMatch(/mcp\/x/)
    })
  })

  it('sends the history every turn instead of chaining', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.delta', content: 'Sagittarius' }),
      evt({ type: 'chat.end', result: { response_id: 'resp_A' } }),
    ]))
    await engine.runTurn(convId, 'what is my sign?')

    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'and tomorrow?')

    const body = bodyOf(f)
    // No dependency on LM Studio's handle at all.
    expect(body).not.toHaveProperty('previous_response_id')
    expect(String(body.system_prompt)).toMatch(/User: what is my sign\?/)
    expect(String(body.system_prompt)).toMatch(/Assistant: Sagittarius/)
    expect(String(body.input)).toMatch(/^and tomorrow\?\n\n\[Sent /)
  })

  it('keeps full context even when the turn between failed', async () => {
    // The reported bug, now structurally impossible.
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.delta', content: 'my name is noted' }),
      evt({ type: 'chat.end', result: { response_id: 'resp_GOOD' } }),
    ]))
    await engine.runTurn(convId, 'my name is Sam')

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection reset'))))
    await engine.runTurn(convId, 'this one fails')

    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'what is my name?')
    expect(String(bodyOf(f).system_prompt)).toMatch(/my name is Sam/)
  })

  it('replays tool data so a follow-up can use it', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'tool_call.start', tool: 'mcp/astrology' }),
      evt({ type: 'tool_call.success', output: 'Sun in Libra' }),
      evt({ type: 'message.delta', content: 'Your sun is in Libra.' }),
      evt({ type: 'chat.end', result: {} }),
    ]))
    await engine.runTurn(convId, 'what is my chart?')

    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'and my rising sign?')
    const prompt = String(bodyOf(f).system_prompt)
    expect(prompt).toMatch(/Sun in Libra/)
    expect(prompt).toMatch(/Tool mcp\/astrology returned/)
  })

  it('honours the configured history budget', async () => {
    configure({ historyChars: '200' })
    store.setMessages(convId, [
      user('old question'.padEnd(500, '!')),
      assistant('old answer'.padEnd(500, '?')),
    ])
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'next')
    // The fixed date note sits outside the history budget.
    expect(String(bodyOf(f).system_prompt).length).toBeLessThan(400 + DATE_NOTE.length + 2)
  })

  describe('auto-compaction', () => {
    const exchange = (i: number, size = 300): Message[] => [
      user(`question ${i} ${'q'.repeat(size)}`),
      assistant(`answer ${i} ${'a'.repeat(size)}`),
    ]
    const thread = (n: number, size?: number): Message[] =>
      Array.from({ length: n }, (_, i) => exchange(i, size)).flat()

    /** A fetch stand-in that answers each call with the next set of frames. */
    function sequence(...calls: string[][]) {
      const f = streams([])
      for (const frames of calls) {
        f.mockImplementationOnce(streams(frames).getMockImplementation()!)
      }
      return f
    }
    const bodyAt = (f: { mock: { calls: unknown[][] } }, i: number): Record<string, unknown> =>
      JSON.parse(String(((f.mock.calls[i]![1]) as RequestInit).body)) as Record<string, unknown>

    it('leaves a thread that fits alone', () => {
      expect(planCompaction(thread(3), null, 24000)).toBeNull()
      expect(planCompaction(thread(300), null, 0)).toBeNull()
    })

    it('folds the older turns and keeps the latest exchange verbatim', () => {
      const history = thread(20)
      const plan = planCompaction(history, null, 6000)!
      expect(plan.fold[0]!.id).toBe(history[0]!.id)
      // Split on an exchange boundary: the next message kept is a user turn.
      const next = history[history.findIndex((m) => m.id === plan.through) + 1]!
      expect(next.role).toBe('user')
      expect(plan.fold).not.toContain(history[history.length - 2])
      expect(plan.fold).not.toContain(history[history.length - 1])
    })

    it('only counts what the summary does not already cover', () => {
      const history = thread(20)
      const summary = { text: 'earlier stuff', through: history[33]!.id }
      expect(planCompaction(history, summary, 6000)).toBeNull()
      const plan = planCompaction(history, { text: 'x', through: history[1]!.id }, 6000)!
      expect(plan.fold[0]!.id).toBe(history[2]!.id)
      expect(plan.previous?.text).toBe('x')
      expect(summarizerInput(plan)).toMatch(/Previous summary:\n\nx/)
    })

    it('replays the summary in place of the turns it covers', () => {
      const history = [...thread(4), user('now')]
      const prompt = buildHistoryPrompt('be terse', history, 24000, {
        text: '- user asked four questions', through: history[3]!.id,
      })!
      expect(prompt).toMatch(/Summary of the earlier conversation:\n\n- user asked four questions/)
      expect(prompt).not.toMatch(/question 1 /)
      expect(prompt).toMatch(/question 2 /)
      expect(prompt.indexOf('Summary')).toBeLessThan(prompt.indexOf('question 2'))
    })

    it('ignores a summary whose anchor message is gone', () => {
      const history = [...thread(2), user('now')]
      const prompt = buildHistoryPrompt('', history, 24000, { text: 'stale', through: 'missing' })!
      expect(prompt).not.toMatch(/stale/)
      expect(prompt).toMatch(/question 0/)
    })

    it('trims on message boundaries when there is no summary to lean on', () => {
      const prompt = buildHistoryPrompt('', [...thread(20), user('now')], 3000)!
      expect(prompt).toMatch(/context:\n\n\.\.\.\n\n(User|Assistant): /)
    })

    it('folds everything so far when asked to, whatever the budget', async () => {
      configure({ historyChars: '24000' })
      store.setMessages(convId, thread(3))
      expect(planFullCompaction(thread(3), null)!.fold).toHaveLength(6)
      expect(planFullCompaction([], null)).toBeNull()
      const f = sequence([evt({ type: 'message.delta', content: '- three questions, answered' }), evt({ type: 'chat.end', result: {} })])
      vi.stubGlobal('fetch', f)
      expect(await engine.compact(convId, { force: true })).toBe(true)
      const conv = store.get(convId)!
      expect(conv.summary?.text).toBe('- three questions, answered')
      expect(conv.summary?.through).toBe(conv.messages[5]!.id)
      expect(conv.messages).toHaveLength(6)
      // Without force the same thread is left alone: it fits.
      expect(await engine.compact(convId)).toBe(false)
    })

    it('summarizes after a turn that pushes the thread over budget', async () => {
      configure({ historyChars: '6000' })
      store.setMessages(convId, thread(12))
      const f = sequence(
        [evt({ type: 'message.delta', content: 'answer 12' }), evt({ type: 'chat.end', result: {} })],
        [evt({ type: 'message.delta', content: '- user asked twelve things' }), evt({ type: 'chat.end', result: {} })],
      )
      vi.stubGlobal('fetch', f)
      const sent: { type: string; payload: unknown }[] = []
      const send = bus.send.bind(bus)
      vi.spyOn(bus, 'send').mockImplementation((e) => { sent.push(e as never); send(e) })
      await engine.runTurn(convId, 'question 12')

      expect(f).toHaveBeenCalledTimes(2)
      const req = bodyAt(f, 1)
      expect(req).not.toHaveProperty('integrations')
      expect(String(req.input)).toMatch(/question 0 /)
      const conv = store.get(convId)!
      expect(conv.summary?.text).toBe('- user asked twelve things')
      // Nothing is removed from the visible thread.
      expect(conv.messages).toHaveLength(26)
      expect(sent.some((e) => e.type === 'patch' &&
        (e.payload as { meta: { summary?: { text: string } } }).meta.summary?.text === '- user asked twelve things')).toBe(true)
      // Metadata only: the thread's messages aren't resent.
      expect(sent.find((e) => e.type === 'patch')!.payload).not.toHaveProperty('meta.messages')

      const g = streams([evt({ type: 'chat.end', result: {} })])
      vi.stubGlobal('fetch', g)
      await engine.runTurn(convId, 'next')
      const prompt = String(bodyOf(g).system_prompt)
      expect(prompt).toMatch(/user asked twelve things/)
      expect(prompt).not.toMatch(/question 0 /)
      expect(prompt).toMatch(/answer 12/)
      expect(prompt.length).toBeLessThan(6000)
    })

    it('keeps the prompt prefix stable between compactions, for the prompt cache', async () => {
      configure({ historyChars: '6000' })
      const history = thread(12)
      store.setMessages(convId, history)
      store.patch(convId, { summary: { text: '- earlier', through: history[15]!.id } })

      const reply = (s: string) => streams([
        evt({ type: 'message.delta', content: s }), evt({ type: 'chat.end', result: {} }),
      ])
      const f = reply('short one')
      vi.stubGlobal('fetch', f)
      await engine.runTurn(convId, 'a')
      const g = reply('short two')
      vi.stubGlobal('fetch', g)
      await engine.runTurn(convId, 'b')

      const first = String(bodyOf(f).system_prompt)
      expect(String(bodyOf(g).system_prompt).startsWith(first)).toBe(true)
    })

    it('carries on without a summary when summarizing fails', async () => {
      configure({ historyChars: '6000' })
      store.setMessages(convId, thread(12))
      const f = sequence(
        [evt({ type: 'message.delta', content: 'fine' }), evt({ type: 'chat.end', result: {} })],
        [evt({ type: 'error', error: { message: 'model crashed' } })],
      )
      vi.stubGlobal('fetch', f)
      await engine.runTurn(convId, 'q')
      expect(store.get(convId)!.summary ?? null).toBeNull()
      expect(messages().some((m) => m.role === 'error')).toBe(false)
    })

    it('does not compact after a failed turn', async () => {
      configure({ historyChars: '6000' })
      store.setMessages(convId, thread(12))
      const f = vi.fn(() => Promise.reject(new TypeError('connection reset')))
      vi.stubGlobal('fetch', f)
      await engine.runTurn(convId, 'q')
      expect(f).toHaveBeenCalledTimes(1)
    })
  })

  it('still records the response id for reference', async () => {
    vi.stubGlobal('fetch', streams([
      evt({ type: 'message.delta', content: 'hello' }),
      evt({ type: 'chat.end', result: { response_id: 'resp_B' } }),
    ]))
    await engine.runTurn(convId, 'hi')
    expect(messages().find((m) => m.role === 'assistant')!.responseId).toBe('resp_B')
  })
})

/** Like `streams`, but paced: one frame every `gapMs`, as a real model emits them. */
function paced(frames: string[], gapMs: number) {
  const enc = new TextEncoder()
  return vi.fn(() => Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const f = frames.shift()
        if (f === undefined) { controller.close(); return }
        await new Promise((r) => setTimeout(r, gapMs))
        controller.enqueue(enc.encode(f))
      },
    }),
  }))
}

describe('streaming load', () => {
  const tokens = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => evt({ type: 'message.delta', content: `t${i} ` }))

  it('streams only the reply, a few times a second -- never the history or the store', async () => {
    const sent: { type: string; payload: unknown }[] = []
    vi.spyOn(bus, 'send').mockImplementation((e) => { sent.push(e as never) })
    // A long thread already: its history must not ride along with each update.
    const bulk = 'x'.repeat(50_000)
    store.setMessages(convId, [
      { id: 'u0', role: 'user', text: 'earlier' },
      { id: 't0', role: 'tool', name: 'chart', output: bulk },
    ])
    // 60 tokens at 10 ms: 600 ms of streaming.
    vi.stubGlobal('fetch', paced([...tokens(60), evt({ type: 'chat.end', result: {} })], 10))
    await engine.runTurn(convId, 'hi')

    const tails = sent.filter((e) => e.type === 'tail')
    expect(tails.length).toBeGreaterThan(1) // clients do see it streaming...
    expect(tails.length).toBeLessThan(12) // ...but coalesced, not 60 frames
    expect(sent.some((e) => e.type === 'conversations')).toBe(false)
    for (const t of tails) {
      const payload = t.payload as { base: number }
      expect(payload.base).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(t.payload).length).toBeLessThan(5_000)
    }
    expect(messages().at(-1)!.text).toBe(Array.from({ length: 60 }, (_, i) => `t${i}`).join(' '))
  })

  it('sends each message of the turn once as it settles, and then only the one still streaming', async () => {
    const sent: { type: string; payload: unknown }[] = []
    vi.spyOn(bus, 'send').mockImplementation((e) => { sent.push(e as never) })
    const chart = JSON.stringify([{ type: 'text', text: 'x'.repeat(50_000) }])
    vi.stubGlobal('fetch', paced([
      evt({ type: 'tool_call.start', tool: 'mcp/astrology' }),
      evt({ type: 'tool_call.success', output: chart }),
      ...tokens(60),
      evt({ type: 'chat.end', result: {} }),
    ], 10))
    await engine.runTurn(convId, 'hi')
    const tails = sent.filter((e) => e.type === 'tail').map((e) => e.payload as { base: number; messages: Message[] })
    // The prompt went first, on its own; the tool result once, when it arrived.
    expect(tails[0]).toMatchObject({ base: 0, messages: [{ role: 'user', text: 'hi' }] })
    const withTool = tails.filter((t) => t.messages.some((m) => m.role === 'tool'))
    expect(withTool.length).toBeLessThanOrEqual(2) // as it starts, and with its output
    // Every tail while the reply streamed carried the reply alone.
    const streaming = tails.filter((t) => t.messages.some((m) => m.role === 'assistant' && m.streaming))
    expect(streaming.length).toBeGreaterThan(1)
    // (The tool's output and the first tokens can share one tail, when both arrive within a tick.)
    expect(streaming.filter((t) => t.messages.map((m) => m.role).join() !== 'assistant').length).toBeLessThanOrEqual(1)
    expect(JSON.stringify(tails).length).toBeLessThan(chart.length * 3)
    // Put together the way a client does, the tails make the thread as stored.
    let held: Message[] = []
    for (const t of tails) held = [...held.slice(0, t.base), ...t.messages]
    expect(held).toEqual(messages())
  })

  it('saves to disk a handful of times, not once per token', async () => {
    const writes = vi.spyOn(fs, 'renameSync')
    vi.stubGlobal('fetch', paced([...tokens(60), evt({ type: 'chat.end', result: {} })], 10))
    await engine.runTurn(convId, 'hi')
    expect(writes.mock.calls.length).toBeLessThanOrEqual(4)
    writes.mockRestore()
  })

  it('never lets a late throttled update overwrite the finished reply', async () => {
    vi.stubGlobal('fetch', paced([...tokens(5), evt({ type: 'chat.end', result: {} })], 60))
    await engine.runTurn(convId, 'hi')
    await new Promise((r) => setTimeout(r, 300))
    const last = messages().at(-1)!
    expect(last.streaming).toBe(false)
    expect(new Store({ dir }).get(convId)!.messages.at(-1)!.streaming).toBe(false)
  })

  it('makes no backups when a placeholder disappears mid-turn', async () => {
    // Log noise before: an empty reply bubble replaced by a tool call looked
    // like a lost message, and each one pushed a real backup out of the 20 kept.
    vi.stubGlobal('fetch', paced([
      evt({ type: 'message.start' }),
      evt({ type: 'message.delta', content: ' ' }),
      evt({ type: 'tool_call.start', tool: 't' }),
      evt({ type: 'tool_call.success', output: 'data' }),
      evt({ type: 'message.delta', content: 'done' }),
      evt({ type: 'chat.end', result: {} }),
    ], 200))
    await engine.runTurn(convId, 'hi')
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false)
    expect(messages().map((m) => m.role)).toEqual(['user', 'tool', 'assistant'])
  })
})

describe('chat order', () => {
  it('moves a chat up when you send, but not as its reply streams or finishes', async () => {
    const enc = new TextEncoder()
    let push!: (e: Record<string, unknown>) => void
    let end!: () => void
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(''),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          push = (e) => c.enqueue(enc.encode(evt(e)))
          end = () => c.close()
        },
      }),
    })))

    const turn = engine.runTurn(convId, 'hi')
    await vi.waitFor(() => expect(push).toBeDefined())
    const sent = store.get(convId)!.updatedAt

    for (let i = 0; i < 5; i++) {
      push({ type: 'message.delta', content: `token ${i} ` })
      await new Promise((r) => setTimeout(r, 200)) // past the publish throttle
    }
    push({ type: 'chat.end', result: { response_id: 'r1' } })
    end()
    await turn

    expect(messages().at(-1)!.text).toMatch(/token 4/)
    expect(store.get(convId)!.updatedAt).toBe(sent)
  })
})

describe('surviving a dev-server restart', () => {
  it('adopts state saved by an older version that lacks newer fields', () => {
    const legacy = { running: new Map(), compacting: new Set() } as unknown as ReturnType<typeof newEngineState>
    const e = new Engine(store, bus, () => Promise.resolve(null), legacy)
    expect(e.activeStatuses()).toEqual([])
    expect(legacy.statuses).toBeInstanceOf(Map)
    expect(legacy.slots).toBe(e.slots)
  })

  it('a rebuilt engine still sees the reply the old one is streaming', async () => {
    const state = newEngineState()
    const before = new Engine(store, bus, () => Promise.resolve(null), state)
    const after = new Engine(store, bus, () => Promise.resolve(null), state)

    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const enc = new TextEncoder()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(''),
      body: new ReadableStream<Uint8Array>({
        async start(controller) {
          await gate
          controller.enqueue(enc.encode(evt({ type: 'chat.end', result: {} })))
          controller.close()
        },
      }),
    })))

    const turn = before.runTurn(convId, 'slow one')
    await vi.waitFor(() => expect(after.isRunning(convId)).toBe(true))
    await expect(after.runTurn(convId, 'retry')).rejects.toThrow(/already in flight/)
    // And the new engine can stop what the old one started.
    expect(after.stop(convId)).toBe(true)
    release()
    await turn
    expect(after.isRunning(convId)).toBe(false)
  })
})

describe('parallel replies', () => {
  /** A second thread. (create() reuses the current one while it's empty.) */
  const secondChat = (): string => {
    store.setMessages(convId, [{ id: 'seed', role: 'user', text: 'earlier' }])
    return store.create().id
  }

  /** A fetch whose streams stay open until released, one per call. */
  function held() {
    const enc = new TextEncoder()
    const releases: (() => void)[] = []
    const f = vi.fn((_u: string, init: RequestInit) => Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(''),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          releases.push(() => {
            controller.enqueue(enc.encode(evt({ type: 'chat.end', result: {} })))
            controller.close()
          })
          init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason as Error))
        },
      }),
    }))
    return { f, releases }
  }

  it('holds a turn past the limit in the app, saying so, until a slot frees', async () => {
    configure({ parallel: '1' })
    const other = secondChat()
    const { f, releases } = held()
    vi.stubGlobal('fetch', f)
    const sent: { type: string; payload: unknown }[] = []
    vi.spyOn(bus, 'send').mockImplementation((e) => { sent.push(e as never) })

    const first = engine.runTurn(convId, 'one')
    const second = engine.runTurn(other, 'two')
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1))
    expect(engine.isRunning(other)).toBe(true)
    expect(engine.activeStatuses().find((s) => s.conversationId === other)?.text)
      .toBe('waiting for a free slot...')

    releases[0]!()
    await first
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    releases[1]!()
    await second
    expect(engine.activeStatuses()).toEqual([])
  })

  it('does not count time spent queued as silence', async () => {
    vi.useFakeTimers()
    try {
      configure({ parallel: '1', stallSeconds: '5' })
      const other = secondChat()
      const { f, releases } = held()
      vi.stubGlobal('fetch', f)
      const first = engine.runTurn(convId, 'one')
      const second = engine.runTurn(other, 'two')
      await vi.advanceTimersByTimeAsync(4000)
      releases[0]!() // the first reply ends just inside its own watchdog
      await first
      await vi.advanceTimersByTimeAsync(4000) // the second has now waited 8s in all
      releases[1]!()
      await second
      expect(store.get(other)!.messages.some((m) => /No output/.test(m.text || ''))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a turn that is still queued', async () => {
    configure({ parallel: '1' })
    const other = secondChat()
    const { f, releases } = held()
    vi.stubGlobal('fetch', f)
    const first = engine.runTurn(convId, 'one')
    const second = engine.runTurn(other, 'two')
    await vi.waitFor(() => expect(engine.isRunning(other)).toBe(true))
    engine.stop(other)
    await second
    expect(f).toHaveBeenCalledTimes(1)
    expect(store.get(other)!.messages.at(-1)!.text).toBe('Stopped.')
    releases[0]!()
    await first
  })
})

describe('auto titles', () => {
  /** A fetch that answers each call with the next set of frames. */
  function sequence(...sets: string[][]) {
    const enc = new TextEncoder()
    let n = 0
    return vi.fn(() => {
      const frames = sets[Math.min(n++, sets.length - 1)]!
      return Promise.resolve({
        ok: true, status: 200, text: () => Promise.resolve(''),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const f of frames) controller.enqueue(enc.encode(f))
            controller.close()
          },
        }),
      })
    })
  }
  const replyFrames = (text: string) => [evt({ type: 'message.delta', content: text }), evt({ type: 'message.end' }), evt({ type: 'chat.end', result: {} })]
  const requestBody = (f: { mock: { calls: unknown[][] } }, i: number): Record<string, unknown> =>
    JSON.parse(String((f.mock.calls[i]![1] as RequestInit).body)) as Record<string, unknown>

  it('writes a title from the first exchange, on the background model, and only once', async () => {
    const seen: string[] = []
    engine = new Engine(store, bus, (config) => { seen.push(config.model); return Promise.resolve({ allowed: ['off', 'on'], default: 'on' }) })
    configure({ autoTitle: 'on', backgroundModel: 'tiny-moe' })
    const f = sequence(replyFrames('Clear skies, 72 and sunny.'), replyFrames('"Tomorrow\'s Weather."'), replyFrames('More sun.'))
    vi.stubGlobal('fetch', f)
    const sent = vi.spyOn(bus, 'send')

    await engine.runTurn(convId, 'What is the forecast for tomorrow?')
    expect(store.get(convId)!.name).toBe("Tomorrow's Weather")
    const ask = requestBody(f, 1)
    expect(ask.model).toBe('tiny-moe')
    expect(ask.max_output_tokens).toBe(24)
    expect(ask.reasoning).toBe('off')
    // Dated with the chat's own day, so "today" in the chat can become a date in the title.
    const started = new Date(store.get(convId)!.createdAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    expect(String(ask.input)).toMatch(new RegExp(`^Chat date: ${started}\\n\\nUser: What is the forecast[\\s\\S]*Assistant: Clear skies`))
    expect(String(ask.system_prompt)).toMatch(/put that date in the title/)
    expect(seen).toContain('tiny-moe')
    // Other tabs learn the new name without a refresh.
    expect(sent.mock.calls.some(([e]) => (e as { type: string; payload: { meta?: { name?: string } } }).type === 'patch'
      && (e as { payload: { meta: { name: string } } }).payload.meta.name === "Tomorrow's Weather")).toBe(true)

    // The next turn doesn't title again: one request, the reply itself.
    await engine.runTurn(convId, 'And the day after?')
    expect(f).toHaveBeenCalledTimes(3)
    expect(store.get(convId)!.name).toBe("Tomorrow's Weather")
  })

  it('never replaces a name you typed, and does nothing when off, for a temporary chat, or without a reply', async () => {
    configure({ autoTitle: 'on' })
    store.patch(convId, { name: 'My weather chat' })
    let f = sequence(replyFrames('Sunny.'))
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'Forecast?')
    expect(f).toHaveBeenCalledTimes(1)
    expect(store.get(convId)!.name).toBe('My weather chat')

    const off = store.create()
    configure({ autoTitle: 'off' })
    f = sequence(replyFrames('Sunny.'))
    vi.stubGlobal('fetch', f)
    await engine.runTurn(off.id, 'Forecast?')
    expect(f).toHaveBeenCalledTimes(1)

    configure({ autoTitle: 'on' })
    const temp = store.create()
    store.patch(temp.id, { temporary: true })
    f = sequence(replyFrames('Sunny.'))
    vi.stubGlobal('fetch', f)
    await engine.runTurn(temp.id, 'Forecast?')
    expect(f).toHaveBeenCalledTimes(1)

    const silent = store.create()
    f = sequence([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(silent.id, 'Forecast?')
    expect(f).toHaveBeenCalledTimes(1) // nothing to title from
    expect(store.get(silent.id)!.name).toBe('Forecast?')
  })

  it('keeps the placeholder when the model answers with nothing usable', async () => {
    configure({ autoTitle: 'on' })
    vi.stubGlobal('fetch', sequence(replyFrames('Sunny.'), replyFrames('"..."')))
    await engine.runTurn(convId, 'Forecast?')
    expect(store.get(convId)!.name).toBe('Forecast?')
  })

  it('names the chats still on placeholder names when asked, even with automatic naming off, skipping ones you named', async () => {
    configure({ autoTitle: 'off' })
    const exchange = (q: string, a: string): Message[] => [{ id: `u-${q}`, role: 'user', text: q }, { id: `a-${q}`, role: 'assistant', text: a }]
    store.setMessages(convId, exchange('How do I brew coffee?', 'Grind, then pour.'))
    const tea = store.create()
    store.setMessages(tea.id, exchange('How long to steep tea?', 'Three minutes.'))
    const named = store.create()
    store.setMessages(named.id, exchange('Anything?', 'Something.'))
    store.patch(named.id, { name: 'Keep me' })
    const f = sequence(replyFrames('Tea Steeping Time'), replyFrames('Coffee Brewing'))
    vi.stubGlobal('fetch', f)

    expect(engine.retitleAll()).toEqual({ candidates: 2 })
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => {
      const names = [store.get(tea.id)!.name, store.get(convId)!.name].sort()
      expect(names).toEqual(['Coffee Brewing', 'Tea Steeping Time'])
    })
    expect(store.get(named.id)!.name).toBe('Keep me')
    // Nothing left to do the second time round.
    expect(engine.retitleAll()).toEqual({ candidates: 0 })
  })

  it('tidies what the model wrote into a title', () => {
    expect(cleanTitle('"Tomorrow\'s Weather."')).toBe("Tomorrow's Weather")
    expect(cleanTitle('Title: **Coffee History**\nSome explanation')).toBe('Coffee History')
    expect(cleanTitle('  many   spaces  here ')).toBe('many spaces here')
    expect(cleanTitle('x'.repeat(80))).toBe(`${'x'.repeat(60)}...`)
    expect(cleanTitle('\n\n')).toBe('')
  })
})

describe('images on a turn', () => {
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const turn = async (text: string, opts?: { images?: ImageUpload[]; retry?: boolean }): Promise<Record<string, unknown>> => {
    const f = streams([evt({ type: 'message.delta', content: 'a cat' }), evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, text, opts)
    return bodyOf(f)
  }

  it('sends the text and each image as input parts, and records the images on the message', async () => {
    const body = await turn('what is this?', { images: [{ name: 'cat.png', mime: 'image/png', dataUrl: png }] })
    const input = body.input as { type: string; content?: string; data_url?: string }[]
    expect(input).toHaveLength(2)
    expect(input[0]).toMatchObject({ type: 'text' })
    expect(input[0]!.content).toMatch(/^what is this\?\n\n\[Sent /)
    expect(input[1]).toEqual({ type: 'image', data_url: png })
    const sent = messages()[0]!
    expect(sent.images).toHaveLength(1)
    expect(sent.images![0]).toMatchObject({ name: 'cat.png', mime: 'image/png', bytes: 4 })
    expect(store.readImage(sent.images![0]!.id)!.bytes.toString('base64')).toBe(png.split(',')[1])
  })

  it('an image alone is a message: the stamp stands in for the text', async () => {
    const body = await turn('', { images: [{ name: 'x.png', mime: 'image/png', dataUrl: png }] })
    expect((body.input as { content: string }[])[0]!.content).toMatch(/^\[Sent /)
  })

  it('later turns name the image in the transcript instead of resending it', async () => {
    await turn('look', { images: [{ name: 'cat.png', mime: 'image/png', dataUrl: png }] })
    const body = await turn('and now?')
    expect(typeof body.input).toBe('string') // no parts: nothing attached this time
    expect(String(body.system_prompt)).toContain('User: [image: cat.png] look')
  })

  it('a retry sends the image again from what was saved', async () => {
    await turn('look', { images: [{ name: 'cat.png', mime: 'image/png', dataUrl: png }] })
    const body = await turn('', { retry: true })
    const input = body.input as { type: string; data_url?: string }[]
    expect(input[1]).toEqual({ type: 'image', data_url: png })
    expect(messages().filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('refuses an upload whose data is not what it claims', async () => {
    await expect(engine.runTurn(convId, 'x', { images: [{ name: 'a', mime: 'image/png', dataUrl: 'data:image/jpeg;base64,AAAA' }] }))
      .rejects.toThrow(/type must match/)
    await expect(engine.runTurn(convId, 'x', { images: [{ name: 'a', mime: 'image/png', dataUrl: 'http://x/y.png' }] }))
      .rejects.toThrow(/data URL/)
  })
})

describe('folder defaults', () => {
  const plugins = (body: Record<string, unknown>): string[] =>
    ((body.integrations as { id: string }[] | undefined) ?? []).map((i) => i.id)
  const turn = async (text: string): Promise<Record<string, unknown>> => {
    const f = streams([evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, text)
    return bodyOf(f)
  }

  beforeEach(() => {
    engine = new Engine(store, bus, () => Promise.resolve({ allowed: ['off', 'low', 'high'], default: 'low' }))
    configure({ reasoning: 'high', mcpTools: 'mcp/deep-research' })
  })

  it("a chat in a folder takes the folder's reasoning and tools over Settings'", async () => {
    const folder = store.createFolder('Astrology')
    store.updateFolder(folder.id, { reasoning: 'off', mcpTools: 'mcp/astrology-v2' })
    store.patch(convId, { folderId: folder.id })
    const body = await turn('hi')
    expect(body.reasoning).toBe('off')
    expect(plugins(body)).toEqual(['mcp/astrology-v2'])
  })

  it("the chat's own level still wins over the folder's", async () => {
    const folder = store.createFolder('Astrology')
    store.updateFolder(folder.id, { reasoning: 'off' })
    store.patch(convId, { folderId: folder.id, reasoning: 'low' })
    expect((await turn('hi')).reasoning).toBe('low')
  })

  it("a chat's own tool list wins over the folder's and Settings', tools named and all", async () => {
    const folder = store.createFolder('Astrology')
    store.updateFolder(folder.id, { mcpTools: 'mcp/astrology-v2' })
    store.patch(convId, { folderId: folder.id, tools: 'mcp/astrology-v2(verify_claim, create_transit_chart)' })
    const body = await turn('hi')
    expect(body.integrations).toEqual([
      { type: 'plugin', id: 'mcp/astrology-v2', allowed_tools: ['verify_claim', 'create_transit_chart'] },
    ])
    store.patch(convId, { tools: '' }) // a real choice of none
    expect(plugins(await turn('again'))).toEqual([])
    store.patch(convId, { tools: null }) // back to the folder's
    expect(plugins(await turn('and again'))).toEqual(['mcp/astrology-v2'])
  })

  it("a folder's empty tool list means no tools at all; an unset one means Settings'", async () => {
    const folder = store.createFolder('Banter')
    store.patch(convId, { folderId: folder.id })
    expect(plugins(await turn('hi'))).toEqual(['mcp/deep-research']) // unset: inherit
    store.updateFolder(folder.id, { mcpTools: '' })
    expect(plugins(await turn('again'))).toEqual([]) // set to nothing: none
    expect((await turn('and again')).reasoning).toBe('high') // reasoning unset: Settings' level
  })
})

describe('reply cap and stats', () => {
  const stats = {
    input_tokens: 9003, total_output_tokens: 747, reasoning_output_tokens: 497,
    tokens_per_second: 19.6053, time_to_first_token_seconds: 1.773,
  }
  const reply = (result: Record<string, unknown>) => streams([
    evt({ type: 'message.delta', content: 'hi' }),
    evt({ type: 'message.end' }),
    evt({ type: 'chat.end', result }),
  ])

  it('sends no cap by default, and the Settings cap when one is set', async () => {
    let f = reply({})
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'one')
    expect(bodyOf(f)).not.toHaveProperty('max_output_tokens')
    configure({ maxOutputTokens: '4000' })
    f = reply({})
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'two')
    expect(bodyOf(f).max_output_tokens).toBe(4000)
  })

  it("keeps LM Studio's numbers for the turn on the reply, rounded, and across a restart", async () => {
    vi.stubGlobal('fetch', reply({ stats }))
    await engine.runTurn(convId, 'hi')
    const expected = { inputTokens: 9003, outputTokens: 747, reasoningTokens: 497, tokensPerSecond: 19.6, firstTokenSeconds: 1.8 }
    expect(messages().at(-1)!.stats).toEqual(expected)
    expect(new Store({ dir }).get(convId)!.messages.at(-1)!.stats).toEqual(expected)
  })

  it('marks a reply that ran into the cap', async () => {
    configure({ maxOutputTokens: '747' })
    vi.stubGlobal('fetch', reply({ stats }))
    await engine.runTurn(convId, 'hi')
    expect(messages().at(-1)!.stats?.capped).toBe(true)
  })

  it('leaves stats off a reply when LM Studio sent none', async () => {
    vi.stubGlobal('fetch', reply({ response_id: 'r1' }))
    await engine.runTurn(convId, 'hi')
    expect(messages().at(-1)!.stats).toBeUndefined()
  })
})

describe('summarizing on a budget', () => {
  it('uses the background model when one is set, with an output cap', async () => {
    const seen: string[] = []
    engine = new Engine(store, bus, (config) => { seen.push(config.model); return Promise.resolve({ allowed: ['off', 'on'], default: 'on' }) })
    configure({ historyChars: '2000', backgroundModel: 'tiny-moe' })
    store.setMessages(convId, Array.from({ length: 20 }, (_, i): Message =>
      ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ${'z'.repeat(200)}` })))
    const f = streams([evt({ type: 'message.delta', content: 'summary' }), evt({ type: 'chat.end', result: {} })])
    vi.stubGlobal('fetch', f)
    await engine.runTurn(convId, 'q')
    const chat = JSON.parse(String(((f.mock.calls as unknown[][])[0]![1] as RequestInit).body)) as Record<string, unknown>
    const summarize = JSON.parse(String(((f.mock.calls as unknown[][])[1]![1] as RequestInit).body)) as Record<string, unknown>
    expect(chat.model).toBe('qwen') // the chat itself is unaffected
    expect(summarize.model).toBe('tiny-moe')
    expect(summarize.max_output_tokens).toBe(summaryTokenCap(2000))
    // Its reasoning options were looked up for the background model, not the chat one.
    expect(seen).toContain('tiny-moe')
  })

  it('clips tool outputs first, then the oldest turns, to keep the summarizer input bounded', () => {
    const fold: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`, role: 'tool', name: 't', output: `${i}:${'x'.repeat(6000)}`, failed: false,
    }))
    const plan = { fold, through: 't9', previous: null }
    // Halving each tool output to 1500 chars is enough: every turn stays.
    const roomy = summarizerInput(plan, 20000)
    expect(roomy.length).toBeLessThanOrEqual(20000)
    expect(roomy.match(/Tool t returned/g)).toHaveLength(10)
    expect(roomy).not.toMatch(/left out/)
    // Even 375-char clips don't fit: the oldest turns go, and it says so.
    const tight = summarizerInput(plan, 3000)
    expect(tight.length).toBeLessThanOrEqual(3000 + 80)
    expect(tight).toMatch(/3 older turns were too long/)
    expect(tight).toMatch(/9:xxx/) // the newest is kept
    expect(tight).not.toMatch(/\n0:xxx|: 0:xxx/) // the oldest went
  })
})

describe('review fixes', () => {
  it('releases the chat when something throws before the request is even made', async () => {
    configure({ model: 'm' })
    const conv = store.create()
    const real = store.getConfig.bind(store)
    const spy = vi.spyOn(store, 'getConfig').mockImplementationOnce(() => { throw new Error('boom') }).mockImplementation(real)
    await expect(engine.runTurn(conv.id, 'hi')).rejects.toThrow('boom')
    spy.mockRestore()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))))
    // Not "a reply is already in flight": the turn runs and reports the real problem.
    await expect(engine.runTurn(conv.id, 'hi again')).resolves.toBeUndefined()
    const last = store.get(conv.id)!.messages.at(-1)!
    expect(last.role).toBe('error')
    expect(last.text).toMatch(/Couldn't reach LM Studio/)
  })
})

describe('wholeSentences', () => {
  it('keeps a recap that ends cleanly, trims one cut off mid-sentence, and leaves a short one alone', () => {
    expect(wholeSentences('You did a thing. It worked.')).toBe('You did a thing. It worked.')
    expect(wholeSentences('You did a thing today, which was good. It worked out nicely. For Thanksgiving, you designated Nov'))
      .toBe('You did a thing today, which was good. It worked out nicely.')
    expect(wholeSentences('A single long thought that never came to a close because the cap')).toBe('A single long thought that never came to a close because the cap')
    expect(wholeSentences('Batteries cost roughly **$80** and last __years__.')).toBe('Batteries cost roughly $80 and last years.')
  })
})
