import { apiSend, OhlcvApiError } from './config'

// Dev-only login gate for wdashboard-server's appstate database (see appstate.py's module
// docstring in that repo) — the client UI and /preferences are gated; /getbars, /search,
// /levels and /stream are not, and stay reachable without a session.

const TOKEN_STORAGE_KEY = 'wd.auth.token'

export interface SessionUser {
  id: number
  username: string
}

interface LoginResult {
  token: string
  expiresAt: number
  user: SessionUser
}

export interface SessionInfo {
  user: SessionUser
  expiresAt: number
}

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

function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_STORAGE_KEY)
    else localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // Nothing to recover: the caller's own state (in-memory token, current page) is what
    // actually drives this session; a failed persist just means it won't survive a reload.
  }
}

// Every authenticated request goes through this rather than reading getToken() directly,
// so "no token" and "empty headers" are the same call site.
export function authHeaders(): Record<string, string> {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function login(username: string, password: string): Promise<SessionUser> {
  const { data } = await apiSend<LoginResult>('POST', '/auth/login', {
    body: { username, password }
  })
  setToken(data.token)
  return data.user
}

export async function logout(): Promise<void> {
  const headers = authHeaders()
  // Clear local state first: the point of logging out is that this browser stops acting
  // as the user, regardless of whether the network round trip below succeeds.
  setToken(null)
  if (!headers.Authorization) return
  await apiSend('POST', '/auth/logout', { headers }).catch(() => {
    // Best-effort server-side invalidation; the token could already be expired, and this
    // browser's copy is gone either way.
  })
}

// Validates the stored token against the server — it can be expired, or have been cleared
// server-side (a shared dev deployment restarted, say) without this browser knowing. Clears
// the stored token on any 401 so the caller doesn't need to duplicate that check.
export async function currentSession(): Promise<SessionInfo | null> {
  const headers = authHeaders()
  if (!headers.Authorization) return null
  try {
    const { data } = await apiSend<SessionInfo>('GET', '/auth/session', { headers })
    return data
  } catch (err) {
    if (err instanceof OhlcvApiError && err.status === 401) {
      setToken(null)
      return null
    }
    throw err
  }
}
