import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Bus } from './bus.ts'
import {
  Engine, formatToolOutput, parseIntegrations, buildHistoryPrompt, planCompaction, summarizerInput,
  newEngineState,
} from './engine.ts'
import { Store } from './store.ts'
import type { Message, ServerConfig } from '../src/types.ts'

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

function configure(patch: Partial<ServerConfig>): void {
  store.setConfig({ model: 'qwen', apiToken: 'sk-lm-TOKEN', ...patch })
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
    // Nothing has been said yet, so there is no transcript to append.
    expect(bodyOf(first).system_prompt).toBe('be terse')
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
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8')) as
      { items: { messages: Message[] }[] }
    expect(onDisk.items[0]!.messages.some((m) => m.text === 'Hello')).toBe(true)
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
    expect(body.input).toBe('and tomorrow?')
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
    expect(String(bodyOf(f).system_prompt).length).toBeLessThan(400)
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
      expect(sent.some((e) => e.type === 'conversation' &&
        (e.payload as { summary?: { text: string } }).summary?.text === '- user asked twelve things')).toBe(true)

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

  it('sends clients the one changed conversation, a few times a second, not the store per token', async () => {
    const sent: string[] = []
    vi.spyOn(bus, 'send').mockImplementation((e) => { sent.push(e.type) })
    // 60 tokens at 10 ms: 600 ms of streaming.
    vi.stubGlobal('fetch', paced([...tokens(60), evt({ type: 'chat.end', result: {} })], 10))
    await engine.runTurn(convId, 'hi')

    const partials = sent.filter((t) => t === 'conversation').length
    expect(partials).toBeGreaterThan(0) // clients do see it streaming...
    expect(partials).toBeLessThan(10) // ...but coalesced, not 60 frames
    // The full store goes out only at the start and end of the turn.
    expect(sent.filter((t) => t === 'conversations').length).toBeLessThanOrEqual(3)
    expect(messages().at(-1)!.text).toBe(Array.from({ length: 60 }, (_, i) => `t${i}`).join(' '))
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
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'conversations.json'), 'utf8')) as
      { items: { messages: Message[] }[] }
    expect(onDisk.items[0]!.messages.at(-1)!.streaming).toBe(false)
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
