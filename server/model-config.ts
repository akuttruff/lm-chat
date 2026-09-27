import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { parse as parseYaml } from 'yaml'
import type { ModelConfig, ReasoningLevel } from '../src/types.ts'

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

/** Shape of the bits of model.yaml we care about. */
interface ManifestField {
  key?: string
  defaultValue?: unknown
  options?: { value?: unknown; label?: string }[]
}
interface Manifest {
  customFields?: ManifestField[]
}

export type ModelConfigResult = ModelConfig | { error: string }

// A model's own manifest declares which reasoning levels it accepts and what
// its default is -- these differ per model, so a fixed list in the UI is wrong.
// e.g. qwen/qwen3.8-27b offers xhigh|medium|low, defaulting to xhigh.
function lmStudioHome(): string {
  return process.env.LMSTUDIO_HOME || path.join(os.homedir(), '.lmstudio')
}

// Model ids look like "publisher/name" or just "name". Anything else -- most
// importantly anything with a path segment -- is refused, so a crafted id
// can't walk out of the models directory and read arbitrary files.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/

export function isSafeModelId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 200 && SAFE_ID.test(id) && !id.includes('..')
}

/** Pull the reasoning-related custom fields out of a parsed model.yaml. */
export function extractConfig(manifest: Manifest | null | undefined): Pick<ModelConfig, 'reasoning' | 'thinking'> {
  const fields: ManifestField[] = Array.isArray(manifest?.customFields) ? manifest.customFields : []
  const byKey = (k: string): ManifestField | undefined => fields.find((f) => f && f.key === k)

  const effort = byKey('reasoningEffort')
  const thinking = byKey('enableThinking')

  return {
    reasoning: effort
      ? {
          default: (effort.defaultValue as string | null | undefined) ?? null,
          options: (effort.options || [])
            .filter((o): o is { value: unknown; label?: string } => !!o && o.value !== undefined)
            .map((o): ReasoningLevel => ({
              value: String(o.value),
              label: o.label || String(o.value),
            })),
        }
      : null,
    thinking: thinking ? { default: thinking.defaultValue !== false } : null,
  }
}

export function readModelConfig(
  modelId: unknown,
  { home }: { home?: string } = {},
): ModelConfigResult {
  if (!isSafeModelId(modelId)) return { error: 'invalid model id' }
  const root = path.join(home || lmStudioHome(), 'hub', 'models')
  const file = path.join(root, modelId, 'model.yaml')
  // Belt and braces: confirm the resolved path really is inside the models dir.
  if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) {
    return { error: 'invalid model id' }
  }
  const missing: ModelConfig = { found: false, model: modelId, reasoning: null, thinking: null }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return missing
  }
  try {
    return { found: true, model: modelId, ...extractConfig(parseYaml(raw) as Manifest) }
  } catch {
    return missing
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function makeMiddleware(home?: string): Middleware {
  return function middleware(req, res, next) {
    const [url, query = ''] = (req.url || '').split('?')
    if (url !== '/api/model-config') return next()
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

    const model = new URLSearchParams(query).get('model')
    if (!model) return json(res, 400, { error: 'model is required' })

    const result = readModelConfig(model, { home })
    if ('error' in result) return json(res, 400, result)
    return json(res, 200, result)
  }
}

export interface ModelConfigOptions {
  /** LM Studio home directory; defaults to $LMSTUDIO_HOME or ~/.lmstudio */
  home?: string
}

export default function modelConfig(options: ModelConfigOptions = {}): Plugin {
  const middleware = makeMiddleware(options.home)
  return {
    name: 'lm-chat-model-config',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
