import { authHeaders, getToken, setToken } from './authtoken'
import { apiSend, OhlcvApiError } from './config'

// Signing in and out of wdashboard-server's dashboard login (its `services/appstate.py`).
// Dev and prod both run it, and where it is configured the SERVER enforces it on every route:
// each HTTP request carries the session as a bearer (config.ts `serverFetch` adds it, so no
// call site does) and WS /stream presents it in its first frame (stream.ts). Only
// `/capabilities`, the login's own `/auth/login` and `/auth/logout` and the indicator config
// page's HTML shell answer without one -- and the tile buckets, which are anonymous reads
// (objectstore.ts). The token itself, and what the page does when the server refuses it, live
// in authtoken.ts.

export { authHeaders, getToken } from './authtoken'

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

export async function login(username: string, password: string): Promise<SessionUser> {
  // A wrong password is a 401 too, and it is the form's to show, not a lost session.
  const { data } = await apiSend<LoginResult>('POST', '/auth/login', {
    body: { username, password },
    unauthorizedIsAnswer: true
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
  // Passed explicitly: the token has already left storage, so serverFetch would find none.
  await apiSend('POST', '/auth/logout', { headers }).catch(() => {
    // Best-effort server-side invalidation; the token could already be expired, and this
    // browser's copy is gone either way.
  })
}

// Validates the stored token against the server — it can be expired, or have been cleared
// server-side (a shared dev deployment restarted, say) without this browser knowing. Clears
// the stored token on any 401 so the caller doesn't need to duplicate that check.
export async function currentSession(): Promise<SessionInfo | null> {
  if (!getToken()) return null
  try {
    // The boot gate's own question: its 401 is answered here (the form), not by the page's
    // signed-out path, which is not armed yet anyway.
    const { data } = await apiSend<SessionInfo>('GET', '/auth/session', {
      unauthorizedIsAnswer: true
    })
    return data
  } catch (err) {
    if (err instanceof OhlcvApiError && err.status === 401) {
      setToken(null)
      return null
    }
    throw err
  }
}
