// WHO this browser is, to the server's owner-scoped route sets: `/sim` (the paper account),
// `/watch` and `/notifications`.
//
// One token, deliberately. The server resolves all three the same way -- the signed-in user
// where the dashboard login is on (dev and prod), else this header -- so a second token minted by
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

/** The owner token as a header. It rides beside the session's bearer (which config.ts
 * `serverFetch` adds to every server request) so one client works against a server with the
 * login and one without: with it on, the server takes the signed-in user and ignores this. */
export function ownerHeaders(): Record<string, string> {
  return { 'X-Sim-Owner': ownerToken() }
}
