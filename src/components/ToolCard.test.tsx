import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolCard from './ToolCard'
import { prettyOutput, sizeLabel, toolLabel } from '../lib/toolFormat.ts'

const long = 'y'.repeat(400)

describe('ToolCard', () => {
  it('names the tool that ran', () => {
    render(<ToolCard name="create_transit_chart" output="ok" />)
    expect(screen.getByText('create transit chart')).toBeInTheDocument()
  })

  it('shows which MCP server provided it', () => {
    render(<ToolCard name="create_transit_chart" plugin="mcp/astrology-v2" output="ok" />)
    expect(screen.getByText('astrology-v2')).toBeInTheDocument()
  })

  it('stays readable when the name never arrived', () => {
    render(<ToolCard output="ok" />)
    expect(screen.getByText('tool')).toBeInTheDocument()
  })

  it('shows short output in full without a toggle', () => {
    render(<ToolCard name="t" output="short result" />)
    expect(screen.getByText('short result')).toBeInTheDocument()
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('collapses long output to one line and its size, until expanded', async () => {
    const user = userEvent.setup()
    const { container } = render(<ToolCard name="t" plugin="mcp/astrology-v2" output={long} />)
    expect(screen.getByText('astrology-v2 · 400 chars')).toBeInTheDocument()
    expect(container.querySelector('.tc-preview')).toBeInTheDocument()
    expect(container.querySelector('.tc-output')).toBeNull()
    await user.click(screen.getByRole('button'))
    expect(container.querySelector('.tc-output')!.textContent).toBe(long)
    expect(container.querySelector('.tc-preview')).toBeNull()
  })

  it('indents JSON when expanded', async () => {
    const user = userEvent.setup()
    const json = JSON.stringify({ chart_type: 'progressed', planets: Array.from({ length: 10 }, (_, i) => ({ name: `p${i}` })) })
    const { container } = render(<ToolCard name="t" output={json} />)
    await user.click(screen.getByRole('button'))
    expect(container.querySelector('.tc-output')!.textContent).toContain('\n  "chart_type": "progressed"')
  })

  it('shows the parameters on one line, then each in full when expanded', async () => {
    const user = userEvent.setup()
    const args = { date_time: '1990-06-15 14:30', city: 'New York', house_system: 'whole_sign', objects: ['Sun', 'Moon'] }
    const { container } = render(<ToolCard name="create_natal_chart" args={args} output="short result" />)
    expect(container.querySelector('.tc-args')!.textContent)
      .toBe('date_time: 1990-06-15 14:30 · city: New York · house_system: whole_sign · objects: ["Sun","Moon"]')
    expect(screen.getByText('short result')).toBeInTheDocument()
    // Short output alone isn't expandable; parameters make it so.
    await user.click(screen.getByRole('button', { expanded: false }))
    const list = container.querySelector('dl.tc-params')!
    expect(list).toHaveAttribute('aria-label', 'Parameters')
    expect([...list.querySelectorAll('.tc-param')].map((p) => p.textContent)).toEqual([
      'date_time1990-06-15 14:30', 'cityNew York', 'house_systemwhole_sign', 'objects["Sun","Moon"]',
    ])
    expect(container.querySelector('.tc-args')).toBeNull()
    expect(screen.getByText('short result')).toBeInTheDocument()
  })

  it('has nothing to expand for a call with no parameters and a short result', () => {
    const { container } = render(<ToolCard name="t" args={{}} output="ok" />)
    expect(container.querySelector('.tc-args')).toBeNull()
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('flags a failed call', () => {
    const { container } = render(<ToolCard name="t" output="timed out" failed />)
    expect(container.querySelector('.tool-card.failed')).toBeInTheDocument()
    expect(screen.getByText('timed out')).toBeInTheDocument()
  })

  it('lays out a tarot draw as its spread', () => {
    const reading = { spread: { id: 'three', name: 'Past, present, future', description: '' }, question: 'Q?', drawnAt: 'x', seed: 1, cards: [1, 2, 3].map((i) => ({ position: { index: i, name: `P${i}`, meaning: '' }, card: { id: `cups-0${i}`, name: `Card ${i}`, arcana: 'minor', suit: 'cups', number: i }, reversed: i === 2, keywords: [], meaning: '' })), summary: {} }
    render(<ToolCard name="draw_cards" plugin="mcp/tarot" output={JSON.stringify(reading)} />)
    expect(screen.getByRole('figure', { name: 'Past, present, future: Q?' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'P2: Card 2, reversed' })).toHaveAttribute('src', '/tarot/cups-02.jpg')
  })

  it('renders without output', () => {
    render(<ToolCard name="t" output="" />)
    expect(screen.getByText('t')).toBeInTheDocument()
  })
})

describe('tool card helpers', () => {
  it('reads tool names as words', () => {
    expect(toolLabel('create_progressed_chart')).toBe('create progressed chart')
    expect(toolLabel(undefined)).toBe('tool')
  })
  it('sizes results', () => {
    expect(sizeLabel(400)).toBe('400 chars')
    expect(sizeLabel(18_500)).toBe('18 KB')
    expect(sizeLabel(2_048)).toBe('2.0 KB')
  })
  it('leaves non-JSON and broken JSON alone', () => {
    expect(prettyOutput('plain text')).toBe('plain text')
    expect(prettyOutput('{broken')).toBe('{broken')
  })
})
