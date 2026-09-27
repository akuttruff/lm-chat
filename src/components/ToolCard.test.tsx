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

  it('flags a failed call', () => {
    const { container } = render(<ToolCard name="t" output="timed out" failed />)
    expect(container.querySelector('.tool-card.failed')).toBeInTheDocument()
    expect(screen.getByText('timed out')).toBeInTheDocument()
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
