// The session token this browser holds, and what happens when the server says it is no good.
//
// The dashboard login (wdashboard-server `services/appstate.py`) is enforced by the SERVER on
// every route where it is configured: each HTTP request presents the token as a bearer
// (config.ts `serverFetch`, the one door every server request goes through) and WS /stream
// presents it in its first frame (stream.ts). Dev and prod both run it. Kept apart from
// auth.ts, which signs in and out over HTTP, so config.ts can read the token without an
// import cycle.

const TOKEN_STORAGE_KEY = 'wd.auth.token'

// localStorage can throw (private-browsing Safari, a full quota, a policy-blocked origin)
// rather than merely fail silently. A user who can't persist a session should see the
// login form again, not a crashed app, so every access here is wrapped.

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE_KEY)
    else localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Nothing to recover: the caller's own state (in-memory token, current page) is what
    // actually drives this session; a failed persist just means it won't survive a reload.
  }
}

/** The bearer header for the token held, or nothing. `serverFetch` adds it to every server
 * request on its own; a caller passes it explicitly only when it must present a token it is
 * about to drop (auth.ts `logout`). */
export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

let onRejected: (() => void) | null = null
let rejected = false

/** What the page does once the server has refused this browser's session: a 401
 * `unauthorized` from any server request, or WS /stream closed with 4401. Armed by
 * client/index.ts once its sign-in gate has passed on a server that advertises `auth`; until
 * then -- and always on a server without the login, where a 401 means something else (the
 * indicator config routes answer 401 there) -- a rejection changes nothing. Arming re-opens the
 * latch; `null` disarms it. */
export function whenSessionRejected(handler: (() => void) | null): void {
  onRejected = handler
  rejected = false
}

/** The server has refused the session. A wall fires many requests at once and every one of
 * them comes back 401, so this acts on the FIRST and ignores the rest for the life of the
 * page: the token is dropped and the page's handler runs once. Each request still fails to
 * its own caller exactly as any failed read does. */
export function sessionRejected(): void {
  if (rejected || onRejected === null) return
  rejected = true
  setToken(null)
  onRejected()
}
