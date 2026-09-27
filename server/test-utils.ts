import http from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Plugin } from 'vite'

export type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

/** A Vite hook may be a bare function or an object with a `handler`. */
function hookFn(hook: unknown): ((server: unknown) => void) | undefined {
  if (typeof hook === 'function') return hook as (server: unknown) => void
  const handler = (hook as { handler?: unknown } | undefined)?.handler
  return typeof handler === 'function' ? (handler as (server: unknown) => void) : undefined
}

/** Run a plugin's server hook and collect the middleware it registers. */
export function collectMiddleware(
  plugin: Plugin,
  which: 'configureServer' | 'configurePreviewServer' = 'configureServer',
): Handler[] {
  const stack: Handler[] = []
  hookFn(plugin[which])?.({ middlewares: { use: (fn: Handler) => stack.push(fn) } })
  return stack
}

/** Serve a plugin's middleware from a real HTTP server on a free port. */
export async function startPlugin(plugin: Plugin): Promise<{ server: Server; base: string }> {
  const stack = collectMiddleware(plugin)
  const server = http.createServer((req, res) => {
    let i = 0
    const next = (): void => {
      const mw = stack[i++]
      if (!mw) {
        res.statusCode = 404
        res.end('no route')
        return
      }
      mw(req, res, next)
    }
    next()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

export const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => server.close(() => resolve()))
