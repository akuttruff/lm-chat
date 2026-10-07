import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Plugin } from 'vite'
import { Bus } from './bus.ts'
import { Engine, newEngineState } from './engine.ts'
import type { EngineState } from './engine.ts'
import { MIME_BY_EXT, Store } from './store.ts'
import type { FolderPatch } from './store.ts'
import { MemoryInputError, Memories } from './memory.ts'
import { ToolCatalogCache } from './tools.ts'
import { readModelConfig } from './model-config.ts'
import { reasoningCapability, toModelConfig, withOffOption } from './capabilities.ts'
import { SpeechError, readSpeakRequest, synthesize } from './speech.ts'
import { isVoice, speedOf } from '../src/lib/speech.ts'
import { metaOf } from '../src/types.ts'
import type { Conversation, ConversationStore, ImageUpload, ServerConfig } from '../src/types.ts'

/** How much a message may carry: enough for a few photos, not a gallery. */
const MAX_IMAGES_PER_MESSAGE = 6
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_MIMES = new Set(Object.values(MIME_BY_EXT))

/**
 * The images on a /turns request, checked for shape, type, count and size
 * before anything is decoded. Throws with the reason, for a 400.
 */
export function imageUploads(raw: unknown): ImageUpload[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('images must be a list')
  if (raw.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`at most ${MAX_IMAGES_PER_MESSAGE} images per message`)
  return raw.map((item, i): ImageUpload => {
    const u = item as Partial<ImageUpload> | null
    if (!u || typeof u.dataUrl !== 'string' || typeof u.mime !== 'string') throw new Error(`image ${i + 1} is malformed`)
    if (!IMAGE_MIMES.has(u.mime)) throw new Error(`image ${i + 1}: ${u.mime} is not a supported type (PNG, JPEG, WebP, GIF)`)
    // base64 is 4/3 the size of the bytes; the limit is on the bytes.
    const comma = u.dataUrl.indexOf(',')
    if (comma < 0 || (u.dataUrl.length - comma) * 3 / 4 > MAX_IMAGE_BYTES) throw new Error(`image ${i + 1} is larger than 8 MB`)
    const name = typeof u.name === 'string' && u.name.trim() ? u.name.trim().slice(0, 120) : `image ${i + 1}`
    return { name, mime: u.mime, dataUrl: u.dataUrl }
  })
}

type Next = () => void
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void

export interface ApiOptions {
  /** Data directory; defaults to <cwd>/.data */
  dir?: string
  /** The shared memory file; defaults to MEMORY_DB or ~/.lm-memory/memory.sqlite. */
  memoryDb?: string
  /** The MCP tool catalog; injectable so tests needn't start real servers. */
  toolCatalog?: ToolCatalogCache
}

/**
 * A state-changing request must come from this app's own page. The server is
 * reachable from any device on your tailnet (or LAN), so without this a web
 * page you happened to visit could write to your chats.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = req.headers.origin
  if (!origin) return true // curl and scripts send none
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * JSON, gzipped for a client that accepts it once it's big enough to matter:
 * a long chat is hundreds of KB of text, and over a phone's connection the
 * transfer, not the server, is what makes opening it slow.
 */
function bigJson(req: IncomingMessage, res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vary', 'Accept-Encoding')
  if (!accepts || text.length < 8 * 1024) return void res.end(text)
  res.setHeader('Content-Encoding', 'gzip')
  res.end(gzipSync(text))
}

/**
 * The chat list as clients receive it: every chat, but only the open one
 * with its messages. The rest carry a count, and a client fetches one when
 * it's opened. Sending every message of every chat made each page load and
 * reconnect download the whole history.
 */
export function listView(s: ConversationStore): ConversationStore {
  return {
    activeId: s.activeId,
    items: s.items.map((c) => (c.id === s.activeId || c.messages.length === 0
      ? { ...c, messageCount: c.messages.length }
      : { ...c, messages: [], messageCount: c.messages.length, messagesOmitted: true })),
  }
}

/** How long, and how many, deleted chats the server keeps for Undo -- enough for a whole selection deleted at once. */
const UNDO_MS = 30 * 60_000
const UNDO_MAX = 300

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
  const memories = new Memories(options.memoryDb)
  const engine = new Engine(store, bus, undefined, state.engine, memories)
  const toolCatalog = options.toolCatalog ?? new ToolCatalogCache()

  /** Recently deleted chats, whole, so Undo can restore one the client only held in outline. */
  const deleted = new Map<string, { conv: Conversation; at: number }>()
  const remember = (conv: Conversation): void => {
    const now = Date.now()
    for (const [k, v] of deleted) if (now - v.at > UNDO_MS) deleted.delete(k)
    deleted.set(conv.id, { conv, at: now })
    while (deleted.size > UNDO_MAX) deleted.delete(deleted.keys().next().value!)
  }

  const middleware: Middleware = (req, res, next) => {
    const [rawUrl = '', query = ''] = (req.url || '').split('?')
    if (!rawUrl.startsWith('/api/')) return next()
    if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin write refused' })
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
      res.write(`data: ${JSON.stringify({ type: 'conversations', payload: listView(store.getConversations()) })}\n\n`)
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
        // An unknown voice or a silly speed is dropped, not stored.
        if (patch.speechVoice !== undefined && !isVoice(patch.speechVoice)) delete patch.speechVoice
        if (patch.speechSpeed !== undefined) patch.speechSpeed = String(speedOf(patch.speechSpeed))
        store.setConfig(patch)
        json(res, 200, store.getPublicConfig())
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }

    // --- speech -------------------------------------------------------------
    // One piece of a reply, read aloud. The page splits a reply into pieces
    // (src/lib/speech.ts) and asks for the next while the last one plays.
    if (url === '/api/speech' && method === 'POST') {
      void readBody(req).then(async (body) => {
        const config = store.getPublicConfig()
        const { text, voice, speed } = readSpeakRequest((body ?? {}) as { text: unknown }, { voice: config.speechVoice, speed: config.speechSpeed })
        const audio = await synthesize(text, voice, speed)
        res.statusCode = 200
        res.setHeader('Content-Type', 'audio/wav')
        res.setHeader('Content-Length', String(audio.length))
        res.setHeader('Cache-Control', 'no-store')
        res.end(audio)
      }).catch((err: Error) => json(res, err instanceof SpeechError ? err.status : 400, { error: err.message }))
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
    // LM Studio's own list, not the OpenAI-compatible one: every LLM it has
    // downloaded, with which are loaded right now. An unloaded one is fine to
    // pick -- LM Studio loads it when the first message asks for it.
    if (url === '/api/models' && method === 'GET') {
      const cfg = store.getConfig()
      const base = cfg.lmStudioUrl.replace(/\/+$/, '')
      void fetch(`${base}/api/v1/models`, {
        headers: cfg.apiToken ? { Authorization: `Bearer ${cfg.apiToken.trim()}` } : {},
        signal: AbortSignal.timeout(5000),
      })
        .then(async (r) => {
          if (!r.ok) {
            const text = await r.text()
            let message = text.slice(0, 300)
            try {
              message = (JSON.parse(text) as { error?: { message?: string } }).error?.message || message
            } catch { /* not JSON */ }
            return json(res, 200, { ok: false, models: [], loaded: [], error: message })
          }
          const data = await r.json() as { models?: { type?: string; key?: string; loaded_instances?: unknown[] }[] }
          const llms = (data.models || [])
            .filter((m) => m.type === 'llm' && m.key)
            .map((m) => ({ key: m.key!, loaded: Boolean(m.loaded_instances?.length) }))
            // Loaded first, then by name: what you can use right now is at the top.
            .sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.key.localeCompare(b.key))
          return json(res, 200, {
            ok: true,
            models: llms.map((m) => m.key),
            loaded: llms.filter((m) => m.loaded).map((m) => m.key),
            error: null,
          })
        })
        .catch((err: Error) => json(res, 200, {
          ok: false, models: [], loaded: [],
          error: `Couldn't reach LM Studio at ${base}. (${err.message})`,
        }))
      return undefined
    }

    // --- MCP tool catalog: what each server offers, for the per-chat picker ---
    if (url === '/api/tools' && method === 'GET') {
      const refresh = new URLSearchParams(query).get('refresh') === '1'
      void toolCatalog.get(refresh)
        .then((catalog) => json(res, 200, catalog))
        .catch((err: Error) => json(res, 500, { error: err.message }))
      return undefined
    }

    // --- memories -----------------------------------------------------
    if (url === '/api/memories' && method === 'GET') {
      return json(res, 200, memories.list())
    }
    const mem = /^\/api\/memories\/([^/]+)$/.exec(url)
    if (mem) {
      const id = decodeURIComponent(mem[1]!)
      if (method === 'DELETE') {
        return memories.forget(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such memory' })
      }
      if (method === 'PATCH') {
        void readBody(req).then((body) => {
          try {
            const updated = memories.update(id, (body as { text?: unknown }).text)
            return updated ? json(res, 200, updated) : json(res, 404, { error: 'no such memory' })
          } catch (err) {
            if (err instanceof MemoryInputError) return json(res, 400, { error: err.message })
            throw err
          }
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
    }

    // --- folders --------------------------------------------------------
    if (url === '/api/folders' && method === 'GET') {
      return json(res, 200, store.listFolders())
    }
    if (url === '/api/folders' && method === 'POST') {
      void readBody(req).then((body) => json(res, 201, store.createFolder((body as { name?: unknown }).name)))
        .catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }
    const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(url)
    if (folderMatch) {
      const id = decodeURIComponent(folderMatch[1]!)
      if (method === 'PATCH') {
        void readBody(req).then((body) => {
          const { name, reasoning, mcpTools, memory, memorySelection } = body as FolderPatch
          const updated = store.updateFolder(id, { name, reasoning, mcpTools, memory, memorySelection })
          return updated ? json(res, 200, updated) : json(res, 404, { error: 'no such folder' })
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
      if (method === 'DELETE') {
        // Whichever chats were in it, so their cleared folderId can be
        // broadcast -- other tabs and devices otherwise keep pointing at a
        // folder id that no longer resolves to anything.
        const affected = store.getConversations().items.filter((c) => c.folderId === id).map((c) => c.id)
        const removed = store.deleteFolder(id)
        if (removed) {
          for (const convId of affected) {
            const conv = store.get(convId)
            if (conv) bus.send({ type: 'patch', payload: { conversationId: convId, meta: metaOf(conv) } })
          }
        }
        return removed
          ? json(res, 200, { ok: true })
          : json(res, 404, { error: 'no such folder' })
      }
    }

    // --- images ---------------------------------------------------------
    // The bytes of an image sent with a message, for the thread to show.
    // Immutable by id, so the browser can keep it for good.
    const image = /^\/api\/images\/([a-z0-9-]+)$/.exec(url)
    if (image && method === 'GET') {
      const found = store.readImage(image[1]!)
      if (!found) return json(res, 404, { error: 'no such image' })
      res.writeHead(200, {
        'Content-Type': found.mime,
        'Content-Length': found.bytes.length,
        'Cache-Control': 'private, max-age=31536000, immutable',
      })
      res.end(found.bytes)
      return undefined
    }

    // --- conversations --------------------------------------------------
    if (url === '/api/chats' && method === 'GET') {
      return bigJson(req, res, 200, listView(store.getConversations()))
    }
    if (url === '/api/chats' && method === 'POST') {
      void readBody(req).then((body) => {
        const folderId = (body as { folderId?: unknown } | null)?.folderId
        let conv = store.create()
        // Started from a folder's + in the drawer: filed there before the
        // first message, so the folder's reasoning and tools apply to it.
        if (typeof folderId === 'string') conv = store.patch(conv.id, { folderId }, { touch: false }) ?? conv
        bus.send({ type: 'created', payload: { conversation: conv, activeId: store.getConversations().activeId } })
        json(res, 200, conv)
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }
    // A one-off backfill, not something the app offers: name the chats that
    // still carry their placeholder names (from before titles were written).
    // Titles land as patch events. `curl -X POST localhost:8010/api/chats/retitle`.
    if (url === '/api/chats/retitle' && method === 'POST') {
      return json(res, 202, engine.retitleAll())
    }
    // Several chats at once, from the drawer's select mode. Each is kept for
    // Undo exactly as a single delete keeps it; ids that no longer exist are
    // skipped rather than failing the batch.
    if (url === '/api/chats/delete' && method === 'POST') {
      void readBody(req).then((body) => {
        const raw = (body as { ids?: unknown } | null)?.ids
        if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
          return json(res, 400, { error: 'ids must be a list of chat ids' })
        }
        const ids = [...new Set(raw as string[])].filter((id) => store.get(id))
        if (ids.length > UNDO_MAX) return json(res, 400, { error: `at most ${UNDO_MAX} chats at once` })
        for (const id of ids) {
          const before = new Set(store.getConversations().items.map((c) => c.id))
          remember(structuredClone(store.get(id)!))
          store.remove(id)
          const after = store.getConversations()
          // Deleting the last thread leaves a fresh blank one in its place.
          const replacement = after.items.find((c) => !before.has(c.id))
          bus.send({ type: 'removed', payload: { conversationId: id, activeId: after.activeId, replacement } })
        }
        return json(res, 200, { ok: true, deleted: ids, activeId: store.getConversations().activeId })
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }
    if (url === '/api/chats/restore' && method === 'POST') {
      void readBody(req).then((body) => {
        // The server's own copy, when it still has one: the client's list
        // may hold the chat without its messages (see listView).
        const input = body as Partial<Conversation> | null
        const kept = typeof input?.id === 'string' ? deleted.get(input.id) : undefined
        if (!kept && input?.messagesOmitted) {
          return json(res, 409, { error: 'That chat can no longer be restored.' })
        }
        const before = store.getConversations().items.map((c) => c.id)
        const conv = store.restore((kept?.conv ?? body) as never)
        if (kept) deleted.delete(kept.conv.id)
        const after = store.getConversations()
        // A blank placeholder the deletion had left is gone again.
        for (const id of before) {
          if (!after.items.some((c) => c.id === id)) {
            bus.send({ type: 'removed', payload: { conversationId: id, activeId: after.activeId } })
          }
        }
        bus.send({ type: 'created', payload: { conversation: conv, activeId: after.activeId } })
        return json(res, 200, { ok: true, id: conv.id })
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }

    // The drawer's search box: chats containing the words, best first.
    if (url === '/api/search' && method === 'GET') {
      const q = new URLSearchParams(query).get('q') ?? ''
      return json(res, 200, { hits: store.search(q) })
    }

    const chat = /^\/api\/chats\/([^/]+)(\/[a-z]+)?$/.exec(url)
    if (chat) {
      const id = decodeURIComponent(chat[1]!)
      const action = chat[2]

      if (!store.get(id)) return json(res, 404, { error: 'no such conversation' })

      if (!action && method === 'GET') {
        return bigJson(req, res, 200, { ...store.get(id)!, messageCount: store.get(id)!.messages.length })
      }
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
        remember(structuredClone(store.get(id)!))
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
          const images = imageUploads((body as { images?: unknown }).images)
          // An image alone is a message ("what is this?" goes without saying).
          if (!text && !images.length) return json(res, 400, { error: 'text is required' })
          if (engine.isRunning(id)) return json(res, 409, { error: 'a reply is already in flight' })
          // Kick it off and answer at once: the turn outlives this request,
          // so a client that disappears no longer kills the generation.
          void engine.runTurn(id, text, { images }).catch((err: Error) => {
            console.log(`[engine] turn failed: ${err.message}`)
          })
          return json(res, 202, { ok: true })
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
      // Edit a message you sent and carry on from there in a new chat, the
      // original left as it was: both versions of the conversation stay.
      if (action === '/branch' && method === 'POST') {
        void readBody(req).then((body) => {
          const { messageId, text: rawText } = (body ?? {}) as { messageId?: unknown; text?: unknown }
          const text = String(rawText ?? '').trim()
          if (typeof messageId !== 'string') return json(res, 400, { error: 'messageId is required' })
          const source = store.get(id)!
          const original = source.messages.find((m) => String(m.id) === messageId)
          if (!original || original.role !== 'user') return json(res, 400, { error: 'only a message you sent can be edited' })
          if (!text && !original.images?.length) return json(res, 400, { error: 'text is required' })
          const conv = store.branch(id, messageId)
          bus.send({ type: 'created', payload: { conversation: conv, activeId: store.getConversations().activeId } })
          void engine.runTurn(conv.id, text, { attachments: original.images ?? [] }).catch((err: Error) => {
            console.log(`[engine] branch turn failed: ${err.message}`)
          })
          return json(res, 202, { ok: true, id: conv.id })
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
      if (action === '/retry' && method === 'POST') {
        if (engine.isRunning(id)) return json(res, 409, { error: 'a reply is already in flight' })
        if (!store.get(id)!.messages.some((m) => m.role === 'user')) return json(res, 400, { error: 'nothing to retry' })
        void engine.retryTurn(id).catch((err: Error) => {
          console.log(`[engine] retry failed: ${err.message}`)
        })
        return json(res, 202, { ok: true })
      }
      if (action === '/stop' && method === 'POST') {
        return json(res, 200, { stopped: engine.stop(id) })
      }
    }

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
