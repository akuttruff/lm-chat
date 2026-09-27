import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ToolCard from './ToolCard'

const long = 'y'.repeat(400)

describe('ToolCard', () => {
  it('names the tool that ran', () => {
    render(<ToolCard name="create_transit_chart" output="ok" />)
    expect(screen.getByText('create_transit_chart')).toBeInTheDocument()
  })

  it('shows which MCP server provided it', () => {
    render(<ToolCard name="create_transit_chart" plugin="mcp/astrology-v2" output="ok" />)
    expect(screen.getByText('mcp/astrology-v2')).toBeInTheDocument()
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

  it('truncates long output until expanded', async () => {
    const user = userEvent.setup()
    render(<ToolCard name="t" output={long} />)
    expect(screen.getByText(/^y+\.\.\.$/).textContent.length).toBeLessThan(130)
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText(long)).toBeInTheDocument()
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
