import { describe, it, expect } from 'vitest'
import { Transcript } from './transcript.ts'
import type { ChatEvent, Message } from '../src/types.ts'

const history: Message[] = [{ id: 'u1', role: 'user', text: 'hi' }]
const meta = { model: 'm', instance: 'm:1', elapsed: '1.0', responseId: null }

describe('Transcript', () => {
  it('shows reasoning and the reply as they stream, and stamps the reply when it ends', () => {
    const t = new Transcript(history)
    t.startReasoning()
    expect(t.visible()).toHaveLength(1) // an empty placeholder is not shown
    t.reasoningDelta('hmm')
    expect(t.visible().at(-1)).toMatchObject({ role: 'reasoning', text: 'hmm', streaming: true })
    t.closeReasoning()
    t.messageDelta('Hel')
    t.messageDelta('lo ')
    expect(t.visible().map((m) => m.role)).toEqual(['user', 'reasoning', 'assistant'])
    t.endMessage(meta)
    expect(t.visible().at(-1)).toMatchObject({ role: 'assistant', text: 'Hello', streaming: false, model: 'm', instance: 'm:1', elapsed: '1.0' })
    expect(t.visible().at(1)).toMatchObject({ role: 'reasoning', streaming: false })
    expect(t.producedAnything()).toBe(true)
  })

  it('drops a reply that said nothing before a tool call, and keeps the one after it', () => {
    const t = new Transcript(history)
    t.messageDelta('')
    t.startTool(undefined)
    t.nameTool('create_transit_chart', 'mcp/astrology', { city: 'Portland' })
    t.toolResult({ type: 'tool_call.success', output: 'the chart' } as ChatEvent)
    t.messageDelta('Here it is.')
    t.finish(meta)
    expect(t.produced.map((m) => m.role)).toEqual(['tool', 'assistant'])
    expect(t.produced[0]).toMatchObject({ name: 'create_transit_chart', plugin: 'mcp/astrology', args: { city: 'Portland' }, output: 'the chart', failed: false })
  })

  it('matches parallel results to their calls by name, and otherwise to the oldest still waiting', () => {
    const t = new Transcript(history)
    t.startTool(undefined); t.nameTool('a', undefined, { x: 1 })
    t.startTool(undefined); t.nameTool('b', undefined, { x: 2 })
    t.startTool(undefined); t.nameTool('c', undefined, undefined)
    t.toolResult({ type: 'tool_call.success', tool_name: 'b', output: 'B' } as ChatEvent)
    t.toolFailure({ type: 'tool_call.failure', reason: 'broke' } as ChatEvent)
    t.toolResult({ type: 'tool_call.success', output: 'C' } as ChatEvent)
    expect(t.produced.map((m) => [m.name, m.output, m.failed])).toEqual([['a', 'broke', true], ['b', 'B', false], ['c', 'C', false]])
    // A failure with no call waiting becomes a call of its own.
    t.toolFailure({ type: 'tool_call.failure', tool_name: 'd', reason: 'no such tool' } as ChatEvent)
    expect(t.produced.at(-1)).toMatchObject({ name: 'd', failed: true })
  })

  it('finishes an open reply with what it has, or notes that there was nothing', () => {
    const cut = new Transcript(history)
    cut.messageDelta('Partial')
    cut.finish(meta)
    expect(cut.produced).toEqual([expect.objectContaining({ text: 'Partial', streaming: false })])
    const empty = new Transcript(history)
    empty.messageDelta('')
    empty.finish(meta)
    expect(empty.produced).toEqual([expect.objectContaining({ text: '(empty response)' })])
    const after = new Transcript(history)
    after.messageDelta('First.'); after.endMessage(meta)
    after.messageDelta('')
    after.finish(meta)
    expect(after.produced.map((m) => m.text)).toEqual(['First.'])
    expect(after.all()).toHaveLength(2)
  })

  it('counts the memory note as nothing produced, and puts the turn stats on the last reply', () => {
    const t = new Transcript(history)
    t.noteMemories([{ text: 'likes tea' }])
    expect(t.producedAnything()).toBe(false)
    expect(t.visible().at(-1)!.output).toContain('1 memory loaded')
    t.messageDelta('Tea.'); t.endMessage(meta)
    t.setStats({ tokensPerSecond: 1, inputTokens: 2, outputTokens: 3, reasoningTokens: 0, firstTokenSeconds: 0.1, capped: false })
    expect(t.produced.at(-1)!.stats).toMatchObject({ outputTokens: 3 })
  })
})
