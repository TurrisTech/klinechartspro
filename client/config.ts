import { authHeaders, sessionRejected } from './authtoken'
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

// Everything under this is wdashboard-server; nothing else is. Resolved against the page
// because the base may be relative (`window.OHLCV_BASE_URL = '/api'`).
const SERVER_ROOT: string = new URL(`${DATASOURCE_BASE_URL}/`, window.location.href).href

export interface ServerFetchInit extends RequestInit {
  /** This call's 401 answers a question about the credentials it sends, not about the session
   * the page holds: the sign-in itself (a wrong password is a 401) and the boot-time session
   * check, which handles its own. Such a 401 is returned to the caller and nothing else. */
  unauthorizedIsAnswer?: boolean
}

/**
 * THE door to wdashboard-server: every HTTP request this client makes to the server goes
 * through here, and nothing else in the browser bundle calls `fetch` for a server URL
 * (client/serverfetch.test.ts scans for one). Its counterpart for the tile buckets is
 * objectstore.ts `objectStoreFetch`, which never carries the bearer.
 *
 * Two things happen here so that no call site has to remember them:
 *
 *  - **The bearer.** Where the server has the login on (`/capabilities` lists `auth`) it
 *    requires `Authorization: Bearer <token>` on every route but `/capabilities`,
 *    `/auth/login`, `/auth/logout` and the indicator config page's HTML shell, so the token
 *    held is sent on every request -- those included, where it is harmless. A server with the
 *    login off ignores it. A caller that sets `Authorization` itself wins (logout
 *    presents the token it has just dropped).
 *  - **A refused session.** A 401 whose body is the server's `unauthorized` error means the
 *    session is gone (expired, signed out in another tab, revoked). The response is handed
 *    back to the caller unchanged -- it fails as any failed read does -- and `sessionRejected`
 *    takes the page to its sign-in once, however many requests were refused together.
 *
 * Refuses a URL outside the server, so the bearer cannot leak to another host or path by a
 * caller handing the wrong URL to the wrong door.
 */
export async function serverFetch(url: URL, init: ServerFetchInit = {}): Promise<Response> {
  if (!url.href.startsWith(SERVER_ROOT)) {
    throw new Error(`serverFetch is for wdashboard-server only (${SERVER_ROOT}), not ${url.href}`)
  }
  const { unauthorizedIsAnswer, ...request } = init
  const headers = new Headers(request.headers)
  if (!headers.has('authorization')) {
    for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value)
  }
  const response = await fetch(url, { ...request, headers })
  if (response.status === 401 && !unauthorizedIsAnswer) {
    // A clone, so the caller still reads the body it always has.
    void response
      .clone()
      .json()
      .then((body: unknown) => {
        if (isErrorBody(body) && body.code === 'unauthorized') sessionRejected()
      })
      .catch(() => {})
  }
  return response
}

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
  return (await apiGetResponse<T>(path, params)).data
}

/** `apiGet` plus the `Response`, for the few reads that carry meaning in a header as well as
 * in the body — `/levels` states how far the indicator feed has computed in
 * `X-Levels-Computed-Through`. Identical in every other respect: same read clock, same error
 * decoding. Cross-origin, only headers the server names in `expose_headers` are readable
 * here; a header this cannot see reads as absent, which every caller must already handle
 * because an older server would not send it either. */
export async function apiGetResponse<T>(
  path: string,
  params?: QueryParams
): Promise<ApiSendResult<T>> {
  const url = apiUrl(path, params)
  const response = await serverFetch(url)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (isErrorBody(body)) {
      throw new OhlcvApiError(response.status, body.code, body.detail, body.field)
    }
    throw new OhlcvApiError(response.status, 'internal', `${response.status} from ${path}`)
  }
  return { data: body as T, response }
}

export interface ApiSendResult<T> {
  data: T
  response: Response
}

// The writing counterpart to apiGet: auth, preferences, the simulator, watches and
// notifications. Takes a method and extra headers (the owner token, If-Match), and returns the
// `Response` beside the body because PUT /preferences' caller wants its `ETag`. The bearer is
// not this function's business either way: serverFetch adds it.
export async function apiSend<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
  path: string,
  options?: { body?: unknown; headers?: Record<string, string>; unauthorizedIsAnswer?: boolean }
): Promise<ApiSendResult<T>> {
  // Writes (and the simulator's own routes) are not market-data reads: never clamped.
  const url = apiUrl(path, { asof: null })
  const response = await serverFetch(url, {
    method,
    headers: {
      ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    unauthorizedIsAnswer: options?.unauthorizedIsAnswer
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
