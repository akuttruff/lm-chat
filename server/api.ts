import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'
import { Bus } from './bus.ts'
import { Engine, newEngineState } from './engine.ts'
import type { EngineState } from './engine.ts'
import { Store } from './store.ts'
import { readModelConfig } from './model-config.ts'
import { reasoningCapability, toModelConfig, withOffOption } from './capabilities.ts'
import { metaOf } from '../src/types.ts'
import type { ConversationStore, ServerConfig } from '../src/types.ts'

type Next = () => void
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void

export interface ApiOptions {
  /** Data directory; defaults to <cwd>/.data */
  dir?: string
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer | string) => {
      body += c
      // Guard against a runaway client filling memory.
      if (body.length > 25 * 1024 * 1024) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) } catch (err) { reject(err as Error) }
    })
    req.on('error', reject)
  })
}

/** What must outlive a dev-server restart: the data, its listeners, and what's in flight. */
export interface ApiState {
  store: Store
  bus: Bus
  engine: EngineState
}

export function createApiState(options: ApiOptions = {}): ApiState {
  return { store: new Store({ dir: options.dir }), bus: new Bus(), engine: newEngineState() }
}

export function createApi(options: ApiOptions = {}, state: ApiState = createApiState(options)) {
  const { store, bus } = state
  const engine = new Engine(store, bus, undefined, state.engine)

  const broadcast = (): void =>
    bus.send({ type: 'conversations', payload: store.getConversations() })

  const middleware: Middleware = (req, res, next) => {
    const [rawUrl = '', query = ''] = (req.url || '').split('?')
    if (!rawUrl.startsWith('/api/')) return next()
    const url = rawUrl.replace(/\/+$/, '') || rawUrl
    const method = req.method || 'GET'

    // --- live updates -------------------------------------------------
    if (url === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      // Send current state immediately so a reconnecting client catches up.
      res.write(`data: ${JSON.stringify({ type: 'conversations', payload: store.getConversations() })}\n\n`)
      // And which chats are mid-reply, so every one shows its own progress.
      res.write(`data: ${JSON.stringify({ type: 'statuses', payload: engine.activeStatuses() })}\n\n`)
      const remove = bus.add(res)
      // Comment frames keep intermediaries from closing an idle stream.
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* gone */ } }, 25_000)
      req.on('close', () => { clearInterval(ping); remove() })
      return undefined
    }

    // --- config -------------------------------------------------------
    if (url === '/api/config' && method === 'GET') {
      return json(res, 200, store.getPublicConfig())
    }
    if (url === '/api/config' && method === 'PUT') {
      void readBody(req).then((body) => {
        const patch = body as Partial<ServerConfig>
        // An absent token means "leave it alone"; '' means "clear it".
        if (patch.apiToken === undefined) delete patch.apiToken
        store.setConfig(patch)
        json(res, 200, store.getPublicConfig())
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }

    // --- reasoning options ------------------------------------------------
    // The model's manifest when it has one (plus Off, if LM Studio accepts
    // it), else what LM Studio reports: a Splash build has no model.yaml but
    // still has a fixed set (off|on).
    if (url === '/api/model-config' && method === 'GET') {
      const model = new URLSearchParams(query).get('model')
      if (!model) return json(res, 400, { error: 'model is required' })
      const manifest = readModelConfig(model)
      if ('error' in manifest) return json(res, 400, manifest)
      const config = { ...store.getConfig(), model: manifest.model! }
      void reasoningCapability(config)
        .then((cap) => {
          if (manifest.found) return json(res, 200, withOffOption(manifest, cap))
          return json(res, 200, cap ? toModelConfig(config.model, cap) : manifest)
        })
        .catch(() => json(res, 200, manifest))
      return undefined
    }

    // --- models (proxied with the server's token) -----------------------
    if (url === '/api/models' && method === 'GET') {
      const cfg = store.getConfig()
      const base = cfg.lmStudioUrl.replace(/\/+$/, '')
      void fetch(`${base}/v1/models`, {
        headers: cfg.apiToken ? { Authorization: `Bearer ${cfg.apiToken.trim()}` } : {},
      })
        .then(async (r) => {
          if (!r.ok) {
            const text = await r.text()
            let message = text.slice(0, 300)
            try {
              message = (JSON.parse(text) as { error?: { message?: string } }).error?.message || message
            } catch { /* not JSON */ }
            return json(res, 200, { ok: false, models: [], error: message })
          }
          const data = await r.json() as { data?: { id: string }[] }
          return json(res, 200, { ok: true, models: (data.data || []).map((m) => m.id), error: null })
        })
        .catch((err: Error) => json(res, 200, {
          ok: false, models: [],
          error: `Couldn't reach LM Studio at ${base}. (${err.message})`,
        }))
      return undefined
    }

    // --- conversations --------------------------------------------------
    if (url === '/api/chats' && method === 'GET') {
      return json(res, 200, store.getConversations())
    }
    if (url === '/api/chats' && method === 'POST') {
      const conv = store.create()
      bus.send({ type: 'created', payload: { conversation: conv, activeId: store.getConversations().activeId } })
      return json(res, 200, conv)
    }
    if (url === '/api/chats' && method === 'PUT') {
      // Retained so an older client can still push a whole store.
      void readBody(req).then((body) => {
        const parsed = body as ConversationStore
        if (!parsed || !Array.isArray(parsed.items)) {
          return json(res, 400, { error: 'expected { items: [] }' })
        }
        store.replaceAll(parsed)
        broadcast()
        return json(res, 200, { ok: true, count: parsed.items.length })
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }

    const chat = /^\/api\/chats\/([^/]+)(\/[a-z]+)?$/.exec(url)
    if (chat) {
      const id = decodeURIComponent(chat[1]!)
      const action = chat[2]

      if (!store.get(id)) return json(res, 404, { error: 'no such conversation' })

      if (!action && method === 'PATCH') {
        void readBody(req).then((body) => {
          const conv = store.patch(id, body as Record<string, never>)
          if (conv) bus.send({ type: 'patch', payload: { conversationId: id, meta: metaOf(conv) } })
          return json(res, 200, conv && metaOf(conv))
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
      if (!action && method === 'DELETE') {
        const before = new Set(store.getConversations().items.map((c) => c.id))
        store.remove(id)
        const after = store.getConversations()
        // Deleting the last thread leaves a fresh blank one in its place.
        const replacement = after.items.find((c) => !before.has(c.id))
        bus.send({ type: 'removed', payload: { conversationId: id, activeId: after.activeId, replacement } })
        return json(res, 200, { ok: true, activeId: after.activeId })
      }
      if (action === '/active' && method === 'POST') {
        store.setActive(id)
        bus.send({ type: 'active', payload: { activeId: id } })
        return json(res, 200, { ok: true, activeId: id })
      }
      if (action === '/turns' && method === 'POST') {
        void readBody(req).then((body) => {
          const text = String((body as { text?: unknown }).text ?? '').trim()
          if (!text) return json(res, 400, { error: 'text is required' })
          if (engine.isRunning(id)) return json(res, 409, { error: 'a reply is already in flight' })
          // Kick it off and answer at once: the turn outlives this request,
          // so a client that disappears no longer kills the generation.
          void engine.runTurn(id, text).catch((err: Error) => {
            console.log(`[engine] turn failed: ${err.message}`)
          })
          return json(res, 202, { ok: true })
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
      if (action === '/stop' && method === 'POST') {
        return json(res, 200, { stopped: engine.stop(id) })
      }
    }

    void query
    return json(res, 404, { error: 'no such endpoint' })
  }

  return { middleware, store, bus, engine }
}

/**
 * Vite re-runs its config -- and so this plugin -- whenever a server file
 * changes, in the same process. A fresh Store there would be a second copy of
 * the conversations, racing the first to write the file, and a fresh Engine
 * would forget the replies still streaming. Keep one of each per process.
 */
const shared = globalThis as typeof globalThis & { __lmChatApi?: Map<string, ApiState> }

export default function api(options: ApiOptions = {}): Plugin {
  const states = (shared.__lmChatApi ??= new Map())
  const key = path.resolve(options.dir ?? '.data')
  let state = states.get(key)
  if (!state) {
    state = createApiState(options)
    states.set(key, state)
  }
  const { middleware } = createApi(options, state)
  return {
    name: 'lm-chat-api',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
