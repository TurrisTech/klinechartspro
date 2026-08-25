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

// The READ CLOCK. When a bar replay is running, every read the chart makes must be clamped
// to the replay's cursor -- bars, indicator values, plugin points, levels, signals -- and the
// server's `asof` query parameter (wdashboard_server/services/asof.py) is what clamps it.
// It is added HERE, in the one URL builder every read goes through, never at a call site:
// a new read added anywhere in the client is clamped by construction. A caller that must
// read past the clock on purpose (the replay's own bar caches, which prefetch ahead of the
// cursor and are hidden from the chart) passes `asof: null` explicitly.
let readClock: number | null = null

export function setReadClock(ms: number | null): void {
  readClock = ms
}

export function getReadClock(): number | null {
  return readClock
}

export type QueryParams = Record<string, string | number | null | undefined>

export function apiUrl(path: string, params?: QueryParams): URL {
  const url = new URL(`${DATASOURCE_BASE_URL}${path}`, window.location.href)
  const query: QueryParams = { ...(params ?? {}) }
  if (!('asof' in query) && readClock !== null) query.asof = readClock
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url
}

// Every REST read goes through here so error bodies are decoded once, in one place.
export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
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

export interface ApiSendResult<T> {
  data: T
  response: Response
}

// The auth + preferences counterpart to apiGet (auth.ts, index.ts) — the one part of this
// client that sends an Authorization header or writes. Includes 'GET' alongside the writing
// methods (unlike apiGet, which has no way to pass a header) because /auth/session and
// GET /preferences both require Authorization, and PUT /preferences' caller wants the
// response's `ETag` header, which apiGet's plain-`T` return does not expose.
export async function apiSend<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  options?: { body?: unknown; headers?: Record<string, string> }
): Promise<ApiSendResult<T>> {
  // Writes (and the simulator's own routes) are not market-data reads: never clamped.
  const url = apiUrl(path, { asof: null })
  const response = await fetch(url, {
    method,
    headers: {
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined
  })
  // 204 (No Content, e.g. logout) has no body to parse.
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new OhlcvApiError(response.status, body.code, body.detail, body.field)
    }
    throw new OhlcvApiError(response.status, 'internal', `${response.status} from ${path}`)
  }
  return { data: body as T, response }
}
