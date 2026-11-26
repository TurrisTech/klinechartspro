// The pure halves of client/serve.ts's /ohlcv proxy (REST and WS /stream), kept apart so they
// can be tested: serve.ts starts a server at import. Bun-side only; never in the browser bundle.

/** Request headers for the upstream. Everything the browser sent -- `Authorization` included,
 * which the server requires on every route where the dashboard login is on -- except the
 * hop-by-hop and origin-bound ones: `host` would route the upstream request to the wrong
 * vhost, and `origin`/`referer` naming localhost would be rejected by the upstream CORS
 * allowlist on preflighted requests. */
export function forwardHeaders(req: Request): Headers {
  const headers = new Headers(req.headers)
  for (const name of ['host', 'origin', 'referer', 'connection']) headers.delete(name)
  return headers
}

// A close frame's reason is at most 123 bytes of UTF-8 (125 less the two-byte code).
const MAX_CLOSE_REASON_BYTES = 123

/** The arguments to close the browser's socket with when the upstream's closed: the server's
 * own code and reason, so the browser sees what the server said -- 4401 is how it says the
 * session is gone (stream.ts), and a proxy closing with its default code would hide that. Empty
 * (a plain close) for the codes that describe what the proxy observed rather than what the
 * server sent -- 1005 no status, 1006 abnormal, 1015 TLS -- which no endpoint may send, and for
 * anything outside the ranges an endpoint may. */
export function forwardedClose(code: number, reason: string): [number, string] | [] {
  const sendable = (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)
  if (!sendable) return []
  const bytes = new TextEncoder().encode(reason)
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return [code, reason]
  // Cut on a character boundary: a decoder in non-fatal mode drops a split trailing sequence.
  let cut = new TextDecoder().decode(bytes.slice(0, MAX_CLOSE_REASON_BYTES))
  while (new TextEncoder().encode(cut).length > MAX_CLOSE_REASON_BYTES) cut = cut.slice(0, -1)
  return [code, cut]
}
