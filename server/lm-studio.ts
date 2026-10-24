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

/** What went wrong with a request LM Studio refused, in words for the chat. */
export async function describeHttpError(res: Response): Promise<string> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      detail = (JSON.parse(text) as { error?: { message?: string } })?.error?.message || ''
    } catch {
      detail = text.slice(0, 200)
    }
  } catch { /* body already consumed or absent */ }
  if (res.status === 401 || res.status === 403) {
    return detail || 'LM Studio rejected the API token. Check it in Settings.'
  }
  if (res.status === 404) {
    return detail || 'Endpoint not found. /api/v1/chat needs LM Studio 0.4.0 or newer.'
  }
  return detail || `LM Studio returned HTTP ${res.status}.`
}
