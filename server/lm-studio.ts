import type { ServerConfig } from '../src/types.ts'

type Target = Pick<ServerConfig, 'lmStudioUrl' | 'apiToken'>

/** LM Studio's address without a trailing slash, for building URLs and saying where it was looked for. */
export const lmStudioBase = (config: Target): string => config.lmStudioUrl.replace(/\/+$/, '')

/**
 * A request to LM Studio's own API (`path` is e.g. `/api/v1/chat`), with
 * the server's token when one is set. Every call goes through here so the
 * token is always sent the same way.
 */
export function lmStudioFetch(
  config: Target,
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${lmStudioBase(config)}${path}`, {
    ...init,
    headers: { ...init.headers, ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken.trim()}` } : {}) },
  })
}
