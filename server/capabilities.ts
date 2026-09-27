import type { ModelConfig, ServerConfig } from '../src/types.ts'

/**
 * What LM Studio itself says a model accepts, from /api/v1/models.
 *
 * Not every model ships a model.yaml -- runtime-specific builds like the
 * Splash (yuzu) ones don't -- and those accept a different reasoning
 * vocabulary (off|on) from their MLX siblings (off|low|medium|xhigh|on).
 * Sending a value the model doesn't list is a hard 400, so the server checks
 * here rather than trusting whatever a chat was last set to.
 */
export interface ReasoningCapability {
  allowed: string[]
  default: string | null
}

interface ModelsResponse {
  models?: {
    key?: string
    loaded_instances?: { id?: string }[]
    capabilities?: { reasoning?: { allowed_options?: string[]; default?: string } }
  }[]
}

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; value: ReasoningCapability | null }>()

export function clearCapabilityCache(): void {
  cache.clear()
}

/**
 * The reasoning options for `config.model`, or null when LM Studio can't be
 * asked or doesn't say. Matches the model key or a loaded instance's id.
 */
export async function reasoningCapability(config: ServerConfig): Promise<ReasoningCapability | null> {
  const model = config.model
  if (!model) return null
  const hit = cache.get(model)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let value: ReasoningCapability | null = null
  try {
    const res = await fetch(`${config.lmStudioUrl.replace(/\/+$/, '')}/api/v1/models`, {
      headers: config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json() as ModelsResponse
    const entry = (data.models || []).find((m) =>
      m.key === model || (m.loaded_instances || []).some((i) => i.id === model))
    const r = entry?.capabilities?.reasoning
    if (r?.allowed_options?.length) {
      value = { allowed: r.allowed_options, default: r.default ?? null }
    }
  } catch {
    // Unreachable: don't cache, so the next turn asks again.
    return null
  }
  cache.set(model, { at: Date.now(), value })
  return value
}

/**
 * Coerce a requested reasoning level onto what the model accepts. Any level
 * of thinking maps to 'on' for an on/off model; with no sensible match the
 * setting is dropped and the model's default applies.
 */
export function fitReasoning(requested: string | null, cap: ReasoningCapability | null): string | null {
  if (!requested || !cap) return requested
  if (cap.allowed.includes(requested)) return requested
  if (requested !== 'off' && cap.allowed.includes('on')) return 'on'
  return null
}

/** The cheapest thinking this model allows, for background work like summaries. */
export function cheapestReasoning(cap: ReasoningCapability | null): string | null {
  if (!cap) return null
  return ['off', 'none', 'minimal', 'low'].find((v) => cap.allowed.includes(v)) ?? null
}

const LABELS: Record<string, string> = {
  off: 'Off', on: 'On', none: 'None', minimal: 'Minimal', low: 'Low',
  medium: 'Medium', high: 'High', xhigh: 'Extra high',
}

/**
 * Whether reasoning can be turned off. A manifest lists only the model's
 * thinking *levels* (xhigh|medium|low for Qwen3.8), yet LM Studio accepts
 * 'off' for the same model. Ask LM Studio when possible; without it, a
 * manifest that declares a thinking toggle is taken to mean yes.
 */
export function canTurnOff(manifest: ModelConfig, cap: ReasoningCapability | null): boolean {
  if (cap) return cap.allowed.includes('off')
  return manifest.thinking != null
}

/** A manifest's levels, plus Off after them when the model accepts it. */
export function withOffOption(manifest: ModelConfig, cap: ReasoningCapability | null): ModelConfig {
  const reasoning = manifest.reasoning
  if (!reasoning || reasoning.options.some((o) => o.value === 'off') || !canTurnOff(manifest, cap)) {
    return manifest
  }
  return { ...manifest, reasoning: { ...reasoning, options: [...reasoning.options, { value: 'off', label: 'Off' }] } }
}

/** The same capability, in the shape the Settings UI already reads from manifests. */
export function toModelConfig(model: string, cap: ReasoningCapability): ModelConfig {
  return {
    found: true,
    model,
    reasoning: {
      default: cap.default,
      options: cap.allowed.map((value) => ({ value, label: LABELS[value] ?? value })),
    },
    thinking: null,
  }
}
