import type { Integration } from '../types.ts'

/**
 * The tools field, as stored and as sent to LM Studio.
 *
 * Stored form: comma-separated plugin ids, each optionally with the subset
 * of its tools in parentheses -- `mcp/astrology-v2(verify_claim,
 * create_transit_chart), mcp/deep-research`. The tool picker writes it and
 * reads it back; nobody has to type it. LM Studio honours the subset as
 * `allowed_tools`, so the model is shown (and pays prompt tokens for) only
 * those tools. Commas inside the parentheses belong to the tool list.
 */
export function parseIntegrations(mcpTools: string): Integration[] {
  const entries = (mcpTools || '').match(/[^,(]+(?:\([^)]*\))?/g) ?? []
  return entries
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry): Integration => {
      const m = /^([^(]+?)\s*\(([^)]*)\)$/.exec(entry)
      const label = (m ? m[1]! : entry).trim()
      // LM Studio wants fully-qualified plugin ids; accept a bare label too.
      const id = label.includes('/') ? label : `mcp/${label}`
      const tools = m ? m[2]!.split(',').map((t) => t.trim()).filter(Boolean) : []
      return tools.length ? { type: 'plugin', id, allowed_tools: tools } : { type: 'plugin', id }
    })
}

/** The stored form of a list of integrations; the inverse of parseIntegrations. */
export function formatIntegrations(list: Integration[]): string {
  return list
    .map((i) => (i.allowed_tools?.length ? `${i.id}(${i.allowed_tools.join(', ')})` : i.id))
    .join(', ')
}
