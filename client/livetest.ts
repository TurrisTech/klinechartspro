// The login for the opt-in tests that call a real wdashboard-server.
//
// Since wdashboard-server 0.57.0 a server with the login on answers 401 to every unsigned read,
// while /capabilities stays public, so "is a server there?" still says yes. A test that reads the
// 401's body as an empty answer then blames whatever it compares against. These helpers send the
// token when there is one and turn a refusal into the sentence that fixes it.
//
// A server with the login off (bin/dev-stack.sh) needs no token. For dev, sign in with the dev
// seed account (wdashboard-server docs/appstate.md names it; it is never used on prod):
//
//   export OHLCV_API_TOKEN=$(curl -s https://wdashboard.dev.turris.app/ohlcv/auth/login \
//     -H 'content-type: application/json' -d '{"username":"...","password":"..."}' | jq -r .token)

import { setToken } from './authtoken'

const fromEnvironment = () => process.env.OHLCV_API_TOKEN?.trim() || undefined

/** The bearer header for a test's own fetch, or nothing when no token was given. */
export function liveHeaders(token = fromEnvironment()): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Fails on a refused read, naming the variable to set rather than the data it did not get. */
export function assertSignedIn(response: Response, what: string): void {
  if (response.status === 401) {
    throw new Error(`sign in: set OHLCV_API_TOKEN (${what} answered 401)`)
  }
}

/** For a test that calls through `serverFetch`, which reads the token from localStorage (absent
 * under bun): holds the token where the client looks for it. Does nothing without a token. */
export function holdLiveToken(token = fromEnvironment()): void {
  if (!token) return
  const items = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key)
  }
  setToken(token)
}
