import { authHeaders } from './auth'

// WHO this browser is, to the server's owner-scoped route sets: `/sim` (the paper account),
// `/watch` and `/notifications`.
//
// One token, deliberately. The server resolves all three the same way -- the signed-in user
// where the appstate database is configured, else this header -- so a second token minted by
// a second module would put a user's watches under one identity and their paper account
// under another, on one browser, with no way to tell from the UI. It lived in
// client/trading/api.ts until watches needed it too.

const OWNER_KEY = 'wd.sim.owner'

/** Minted once per browser and kept, so a reload finds the same account. The key name is
 * historical (`sim`) and stays: renaming it would strand every existing account and every
 * watch created before the rename. */
export function ownerToken(): string {
  try {
    let token = localStorage.getItem(OWNER_KEY)
    if (!token) {
      token = crypto.randomUUID()
      localStorage.setItem(OWNER_KEY, token)
    }
    return token
  } catch {
    return 'anonymous'
  }
}

/** Auth plus the owner token. Both are sent regardless of which one the server will use, so
 * one client works against a server with auth and one without. */
export function ownerHeaders(): Record<string, string> {
  return { ...authHeaders(), 'X-Sim-Owner': ownerToken() }
}
