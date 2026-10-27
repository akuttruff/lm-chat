import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
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
import { HealthCheck } from './health.ts'
import { lmStudioBase, lmStudioFetch } from './lm-studio.ts'
import { readModelConfig } from './model-config.ts'
import { clearCapabilityCache, reasoningCapability, toModelConfig, withOffOption } from './capabilities.ts'
import { ModelLoader } from './model-load.ts'
import { SpeechError, Tracks, readSpeakRequest, synthesize, trackType } from './speech.ts'
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
  /** How tracks are shrunk for the phone; null keeps WAV (tests), absent uses afconvert. */
  trackEncoder?: import('./speech.ts').TrackEncoder | null
  /** Write the transit readings a restart cut off, at boot; false keeps a test's fetch quiet. */
  resume?: boolean
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

/** A reply's whole text, for a track; the body limit guards memory, this guards the voice's patience. */
const MAX_TRACK_CHARS = 200_000

/**
 * A file with HTTP ranges, which is what lets a phone scrub a track and
 * play it on with the screen off. One range at a time, as browsers ask.
 */
function serveRange(req: IncomingMessage, res: ServerResponse, file: string, size: number, type: string): void {
  res.setHeader('Content-Type', type)
  res.setHeader('Accept-Ranges', 'bytes')
  // The name carries a hash of the contents, so a cached copy is never stale.
  res.setHeader('Cache-Control', 'private, max-age=86400')
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
  let start = 0
  let end = size - 1
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1])
      if (range[2]) end = Math.min(Number(range[2]), size - 1)
    } else {
      start = Math.max(0, size - Number(range[2]))
    }
    if (start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  } else {
    res.statusCode = 200
  }
  res.setHeader('Content-Length', String(end - start + 1))
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
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
/** Readings cut off by a restart are resumed this long after boot, once the server answers. */
const RESUME_DELAY_MS = 2000
const UNDO_MAX = 300

/** The largest body a request may carry: a full set of images as base64, plus room for the words. */
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGES_PER_MESSAGE * MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024

export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // Raw bytes, decoded once at the end: a character can be split across
    // two chunks, and decoding each chunk alone would garble it.
    let chunks: Buffer[] = []
    let bytes = 0
    let tooLarge = false
    req.on('data', (c: Buffer | string) => {
      if (tooLarge) return
      const chunk = typeof c === 'string' ? Buffer.from(c) : c
      chunks.push(chunk)
      bytes += chunk.byteLength
      // Guard against a runaway client filling memory. The rest is drained,
      // not cut off: destroying the socket would lose the 400 that explains.
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true
        chunks = []
        reject(new Error(`body too large (over ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB)`))
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      const body = Buffer.concat(chunks).toString('utf8')
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) } catch (err) { reject(err as Error) }
    })
    req.on('error', reject)
  })
}

/**
 * What must outlive a dev-server restart: the data, its listeners, and
 * what's in flight -- tracks being rendered, the chats kept for Undo, and
 * the tool catalog already fetched.
 */
export interface ApiState {
  store: Store
  bus: Bus
  engine: EngineState
  /** Replies rendered as one audio file each, beside the database. */
  tracks: Tracks
  /** Recently deleted chats, whole, so Undo can restore one the client only held in outline. */
  deleted: Map<string, { conv: Conversation; at: number }>
  toolCatalog: ToolCatalogCache
  /**
   * The chat model's load, started when it's picked. Kept here so a turn
   * sent after a dev-server reload still waits on a load begun before it.
   * Optional: state kept from before a code change may predate it.
   */
  models?: ModelLoader
}

const newModelLoader = (bus: Bus): ModelLoader => new ModelLoader((payload) => bus.send({ type: 'model', payload }))

export function createApiState(options: ApiOptions = {}): ApiState {
  const store = new Store({ dir: options.dir })
  // Only on a fresh process: a dev-server reload keeps this state, and its turns.
  const cut = store.settleInterrupted()
  if (cut) console.log(`[chats] ${cut} ${cut === 1 ? 'reply was' : 'replies were'} cut off by the last restart`)
  const bus = new Bus()
  return {
    store, bus, engine: newEngineState(), models: newModelLoader(bus),
    tracks: new Tracks(path.join(path.resolve(options.dir ?? '.data'), 'speech'), { encoder: options.trackEncoder }),
    deleted: new Map(),
    toolCatalog: options.toolCatalog ?? new ToolCatalogCache(),
  }
}

export function createApi(options: ApiOptions = {}, state: ApiState = createApiState(options)) {
  const { store, bus, tracks, deleted, toolCatalog } = state
  const memories = new Memories(options.memoryDb)
  const models = state.models ??= newModelLoader(bus)
  const engine = new Engine(store, bus, undefined, state.engine, memories, models)
  /** `GET /api/health`: the process, its data file, the model server and the memory file. */
  const health = new HealthCheck({
    app: 'lm-chat',
    dataFile: path.join(path.resolve(options.dir ?? '.data'), 'lm-chat.sqlite'),
    busy: () => ({ replies: engine.activeStatuses().length, background: engine.backgroundJobs() }),
    deps: {
      model: async () => {
        const config = store.getConfig()
        const r = await lmStudioFetch(config, '/api/v1/models', {
          signal: AbortSignal.timeout(4000),
        })
        if (!r.ok) throw new Error(`${r.status} from ${config.lmStudioUrl}`)
      },
      memory: async () => { memories.list() },
    },
  })
  // A chart whose readings were being written when the server last stopped
  // would say "on its way" for good: pick those up once the server is up.
  if (options.resume !== false) setTimeout(() => engine.readingsAll(), RESUME_DELAY_MS).unref()

  /** A chat past Undo is forgotten, and so are the images a temporary one held in memory. */
  const forget = (id: string): void => { deleted.delete(id); store.releaseImages(id) }
  const prune = (): void => {
    const now = Date.now()
    for (const [k, v] of deleted) if (now - v.at > UNDO_MS) forget(k)
  }
  const remember = (conv: Conversation): void => {
    prune()
    deleted.set(conv.id, { conv, at: Date.now() })
    while (deleted.size > UNDO_MAX) forget(deleted.keys().next().value!)
    setTimeout(prune, UNDO_MS + 1000).unref()
  }
  /** Delete a chat, keeping it for Undo, and tell every client. */
  const deleteChat = (id: string): void => {
    const before = new Set(store.getConversations().items.map((c) => c.id))
    remember(structuredClone(store.get(id)!))
    store.remove(id)
    const after = store.getConversations()
    // Deleting the last thread leaves a fresh blank one in its place.
    const replacement = after.items.find((c) => !before.has(c.id))
    bus.send({ type: 'removed', payload: { conversationId: id, activeId: after.activeId, replacement } })
  }

  const middleware: Middleware = (req, res, next) => {
    const [rawUrl = '', query = ''] = (req.url || '').split('?')
    if (!rawUrl.startsWith('/api/')) return next()
    if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin write refused' })
    const url = rawUrl.replace(/\/+$/, '') || rawUrl
    const method = req.method || 'GET'

    // What a restart would cut off: replies being written and the jobs
    // that follow them (summary, title, readings). scripts/deploy.sh waits
    // for both to be zero.
    if (url === '/api/busy' && method === 'GET') {
      return json(res, 200, { replies: engine.activeStatuses().length, background: engine.backgroundJobs() })
    }
    if (url === '/api/health' && method === 'GET') {
      void health.report().then((h) => json(res, 200, h)).catch((err: Error) => json(res, 500, { error: err.message }))
      return undefined
    }

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
      // And how the model picked last is loading, so Settings and the header can say.
      const load = models.state()
      if (load) res.write(`data: ${JSON.stringify({ type: 'model', payload: load })}\n\n`)
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
        // Only the two systems astro-mcp casts in.
        if (patch.houseSystem !== undefined && patch.houseSystem !== 'whole_sign' && patch.houseSystem !== 'placidus') delete patch.houseSystem
        const before = store.getConfig().model
        const after = store.setConfig(patch)
        // A new chat model is loaded now, not on its first message. Not the
        // background model: that one is for work no one is waiting on.
        if (after.model !== before) {
          clearCapabilityCache()
          void models.ensure(after)
        }
        json(res, 200, store.getPublicConfig())
      }).catch((err: Error) => json(res, 400, { error: err.message }))
      return undefined
    }
    // Load the chat model again: Settings' Retry after a failed load.
    if (url === '/api/model/load' && method === 'POST') {
      const config = store.getConfig()
      if (!config.model) return json(res, 400, { error: 'No model selected.' })
      // Answered at once; how it goes arrives as `model` events.
      void models.ensure(config)
      return json(res, 202, { ok: true })
    }

    // --- speech -------------------------------------------------------------
    // One piece of a reply, read aloud. The page splits a reply into pieces
    // (src/lib/speech.ts) and asks for the next while the last one plays.
    // A whole reply as one track: ask for it (again, to poll), then play the
    // file it names. See Tracks in speech.ts.
    if (url === '/api/speech/tracks' && method === 'POST') {
      void readBody(req).then((body) => {
        const { id, text, voice, speed } = (body ?? {}) as { id?: unknown; text?: unknown; voice?: unknown; speed?: unknown }
        if (typeof id !== 'string' || !id) return json(res, 400, { error: 'id is required' })
        if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'Nothing to say.' })
        if (text.length > MAX_TRACK_CHARS) return json(res, 400, { error: `At most ${MAX_TRACK_CHARS} characters.` })
        const config = store.getPublicConfig()
        const chosen = readSpeakRequest({ text: 'x', voice, speed }, { voice: config.speechVoice, speed: config.speechSpeed })
        return json(res, 200, tracks.prepare(id, text, chosen.voice, chosen.speed))
      }).catch((err: Error) => json(res, err instanceof SpeechError ? err.status : 400, { error: err.message }))
      return undefined
    }
    const track = /^\/api\/speech\/tracks\/([^/]+)$/.exec(url)
    if (track && (method === 'GET' || method === 'HEAD')) {
      const file = tracks.path(decodeURIComponent(track[1]!))
      let size: number
      try { size = file ? fs.statSync(file).size : -1 } catch { size = -1 }
      if (!file || size < 0) return json(res, 404, { error: 'no such track' })
      serveRange(req, res, file, size, trackType(file))
      return undefined
    }

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
          // A model LM Studio says takes no reasoning setting gets none offered, whatever its manifest lists.
          if (manifest.found && !(cap && !cap.allowed.length)) return json(res, 200, withOffOption(manifest, cap))
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
      const base = lmStudioBase(cfg)
      void lmStudioFetch(cfg, '/api/v1/models', {
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
    // Likewise for recaps: chats compacted before recaps existed get one.
    // `curl -X POST localhost:8010/api/chats/recap`.
    // `?all=1` rewrites the recaps that exist too.
    if (url === '/api/chats/recap' && method === 'POST') {
      return json(res, 202, engine.recapAll({ all: /(^|&)all=1(&|$)/.test(query) }))
    }
    // And for transit readings: every chart drawn before readings existed
    // gets its popups' sentences. `curl -X POST localhost:8010/api/chats/readings`.
    // `?all=1` rewrites the readings that exist too.
    if (url === '/api/chats/readings' && method === 'POST') {
      return json(res, 202, engine.readingsAll({ all: /(^|&)all=1(&|$)/.test(query) }))
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
        for (const id of ids) deleteChat(id)
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
          // Only what a client may set: never the id, the messages, or timestamps.
          const input = (body ?? {}) as Record<string, unknown>
          const allowed: Partial<Conversation> = {}
          if ('name' in input) {
            if (typeof input.name !== 'string') throw new Error('name must be text')
            allowed.name = input.name
          }
          if ('reasoning' in input) allowed.reasoning = typeof input.reasoning === 'string' ? input.reasoning : null
          for (const key of ['memory', 'memorySelection', 'starred', 'folderId', 'temporary', 'tools', 'folded', 'recap'] as const) {
            if (key in input) (allowed as Record<string, unknown>)[key] = input[key]
          }
          const conv = store.patch(id, allowed)
          if (conv) bus.send({ type: 'patch', payload: { conversationId: id, meta: metaOf(conv) } })
          return json(res, 200, conv && metaOf(conv))
        }).catch((err: Error) => json(res, 400, { error: err.message }))
        return undefined
      }
      if (!action && method === 'DELETE') {
        deleteChat(id)
        return json(res, 200, { ok: true, activeId: store.getConversations().activeId })
      }
      // The /compact command: summarize everything so far, now. Answers once
      // the summary is in place (it takes the model a few seconds), so the
      // client can fold the thread behind it.
      if (action === '/compact' && method === 'POST') {
        if (engine.isRunning(id)) return json(res, 409, { error: 'Wait for the reply to finish, then compact.' })
        const before = store.get(id)!.messages.length
        void engine.compact(id, { force: true }).then(async (done) => {
          let conv = store.get(id)
          if (!done || !conv?.summary) return json(res, 400, { error: 'Nothing to compact yet, or the summary could not be made. Check that a model is selected.' })
          // Folded on the server, so every device shows the chat from the summary on.
          conv = store.patch(id, { folded: true, recap: null }, { touch: false }) ?? conv
          bus.send({ type: 'patch', payload: { conversationId: id, meta: metaOf(conv) } })
          // And a recap the reader can actually read, in place of what was folded.
          const recap = await engine.recap(id)
          return json(res, 200, { ok: true, summary: conv.summary, folded: before, recap })
        }).catch((err: Error) => json(res, 500, { error: err.message }))
        return undefined
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
