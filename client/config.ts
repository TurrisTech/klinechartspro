import { isErrorBody } from './ohlcv'

// Base URL for the wdashboard-server OHLCV REST API.
//
// Defaults to the current page's origin, which is correct in both topologies this client
// runs in: deployed, the bundle is served from the same host Traefik routes /ohlcv on; in
// local dev, client/serve.ts proxies /ohlcv to the dev cluster. Same-origin is not just
// convenience — the server's CORS allowlist names one production origin, so a cross-origin
// fetch from anywhere else is refused outright.
//
// Override by setting `window.OHLCV_BASE_URL` before this module runs (e.g. an inline
// <script> in index.html) — no bundler env-var plumbing required.
declare global {
  interface Window {
    OHLCV_BASE_URL?: string
  }
}

export const DATASOURCE_BASE_URL: string = (
  window.OHLCV_BASE_URL ?? `${window.location.origin}/ohlcv`
).replace(/\/+$/, '')

// WebSocket URL for the OHLCV live stream (`WS /stream`), derived from the REST datasource
// base: append "/stream" and swap http(s) -> ws(s).
function resolveStreamUrl(): string {
  const url = new URL(`${DATASOURCE_BASE_URL}/stream`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export const STREAM_URL: string = resolveStreamUrl()

// An error carrying the server's machine-readable ErrorBody, so callers can branch on
// `code` (degrade on 'unsupported', narrow the range on 'too_large') instead of parsing
// prose out of `detail`.
export class OhlcvApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly field?: string | null
  ) {
    super(detail)
    this.name = 'OhlcvApiError'
  }
}

export function apiUrl(path: string, params?: Record<string, string | number | undefined>): URL {
  const url = new URL(`${DATASOURCE_BASE_URL}${path}`, window.location.href)
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url
}

// Every REST read goes through here so error bodies are decoded once, in one place.
export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const url = apiUrl(path, params)
  const response = await fetch(url)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new OhlcvApiError(response.status, body.code, body.detail, body.field)
    }
    throw new OhlcvApiError(response.status, 'internal', `${response.status} from ${path}`)
  }
  return body as T
}
