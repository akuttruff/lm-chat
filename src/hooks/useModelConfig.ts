import { useState, useEffect } from 'react'
import type { ModelConfig } from '../types.ts'

/**
 * Reasoning levels a model actually accepts, read from its LM Studio manifest.
 * They differ per model -- qwen3.8-27b offers xhigh|medium|low while the
 * generic REST vocabulary is off|low|medium|high|on -- so the UI has to ask
 * rather than assume.
 */
export default function useModelConfig(model: string | undefined): ModelConfig | null {
  const [config, setConfig] = useState<ModelConfig | null>(null)

  useEffect(() => {
    if (!model) {
      setConfig(null)
      return undefined
    }
    let cancelled = false
    fetch(`/api/model-config?model=${encodeURIComponent(model)}`)
      .then((r) => (r.ok ? (r.json() as Promise<ModelConfig>) : null))
      .then((c) => { if (!cancelled) setConfig(c) })
      .catch(() => { if (!cancelled) setConfig(null) })
    return () => { cancelled = true }
  }, [model])

  return config
}
