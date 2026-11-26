import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { StreamRefusal } from './stream'

// WS /stream presents the session in its FIRST frame, `{"action": "auth", "token": ...}` (a
// browser cannot set a header on a WebSocket handshake, and a token in the URL ends up in
// access logs), and sends its subscribes right behind it without waiting for the answer. A
// close with code 4401 is the server saying the session is gone.

const pristine = {
  WebSocket: globalThis.WebSocket,
  window: (globalThis as Record<string, unknown>).window,
  localStorage: (globalThis as Record<string, unknown>).localStorage,
  hadWindow: 'window' in globalThis,
  hadLocalStorage: 'localStorage' in globalThis
}

const storage = new Map<string, string>()
if (!pristine.hadWindow) {
  ;(globalThis as Record<string, unknown>).window = {
    location: { href: 'http://localhost/', origin: 'http://localhost' }
  }
}
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
}

type Listener = (event: unknown) => void

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  readonly sent: Record<string, unknown>[] = []
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string) {
    sockets.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('send on a socket that is not open')
    this.sent.push(JSON.parse(data))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeSocket.CLOSED) return
    this.drop(code, reason)
  }

  // -- the server's side -------------------------------------------------------------------
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open', {})
  }

  receive(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) })
  }

  drop(code: number, reason = ''): void {
    this.readyState = FakeSocket.CLOSED
    this.emit('close', { code, reason, wasClean: code !== 1006 })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

let sockets: FakeSocket[] = []
;(globalThis as Record<string, unknown>).WebSocket = FakeSocket

const { StreamClient } = await import('./stream')
const authtoken = await import('./authtoken')

const TOKEN_KEY = 'wd.auth.token'
const RECONNECT_WAIT_MS = 1_150 // RECONNECT_BASE_MS plus slack
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

afterAll(() => {
  ;(globalThis as Record<string, unknown>).WebSocket = pristine.WebSocket
  if (pristine.hadWindow) (globalThis as Record<string, unknown>).window = pristine.window
  else delete (globalThis as Record<string, unknown>).window
  if (pristine.hadLocalStorage) (globalThis as Record<string, unknown>).localStorage = pristine.localStorage
  else delete (globalThis as Record<string, unknown>).localStorage
})

beforeEach(() => {
  sockets = []
  storage.clear()
  authtoken.whenSessionRejected(null)
})

// Leave no client reconnecting into the next test: a 4401 with nothing armed stops one for good.
afterEach(() => {
  authtoken.whenSessionRejected(null)
  for (const socket of sockets) if (socket.readyState !== FakeSocket.CLOSED) socket.drop(4401)
})

function barListener() {
  const bars: unknown[] = []
  return { bars, listener: { onBar: (bar: unknown) => void bars.push(bar) } }
}

describe('the auth frame', () => {
  test('is the first frame on open, and the subscribes follow at once', () => {
    storage.set(TOKEN_KEY, 'tok-1')
    const client = new StreamClient()
    client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
    client.subscribePlugin('arev', null, 'oanda', 'EURUSD', '1h', { onPoint: () => {} })
    client.subscribeNotifications({ owner: 'owner-1' }, () => {})
    expect(sockets).toHaveLength(1)
    sockets[0].open()
    const sent = sockets[0].sent
    expect(sent[0]).toEqual({ action: 'auth', token: 'tok-1' })
    // Not waiting for auth_ok: everything else is already behind it.
    expect(sent.slice(1).map((f) => f.action)).toEqual(['subscribe', 'subscribe', 'subscribe'])
    expect(sent.filter((f) => f.action === 'auth')).toHaveLength(1)
  })

  test('is sent again first on every reconnect, with the token held then', async () => {
    storage.set(TOKEN_KEY, 'tok-1')
    const client = new StreamClient()
    client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
    sockets[0].open()
    sockets[0].receive({ type: 'auth_ok', serverTime: 1 })
    storage.set(TOKEN_KEY, 'tok-2')
    sockets[0].drop(1006)
    await sleep(RECONNECT_WAIT_MS)
    expect(sockets).toHaveLength(2)
    sockets[1].open()
    expect(sockets[1].sent[0]).toEqual({ action: 'auth', token: 'tok-2' })
    expect(sockets[1].sent[1]).toMatchObject({ action: 'subscribe', vendor: 'oanda', symbol: 'EURUSD', interval: '1h' })
  })

  test('is not sent without a token', () => {
    const client = new StreamClient()
    client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
    sockets[0].open()
    expect(sockets[0].sent.map((f) => f.action)).toEqual(['subscribe'])
  })

  test('an error frame is reported', () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const client = new StreamClient()
      client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
      sockets[0].open()
      sockets[0].receive({ type: 'error', code: 'invalid_request', errmsg: "Unknown action 'bogus'" })
      expect(errors).toHaveBeenCalledTimes(1)
    } finally {
      errors.mockRestore()
    }
  })
})

// Since wdashboard-server 0.60.3 an error about a subscription names it, so the client can say
// which one the server refused instead of logging an error nobody can place.
describe('a refused subscription', () => {
  const quiet = () => [spyOn(console, 'warn').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {})]

  test('of bars is recorded with the server reason, and cleared once the key is acked', () => {
    const [warnings, errors] = quiet()
    try {
      const client = new StreamClient()
      const seen: StreamRefusal[][] = []
      client.onRefusals((r) => seen.push(r))
      client.subscribe('oanda', 'EURUSD', '7s', barListener().listener)
      sockets[0].open()
      sockets[0].receive({
        type: 'error',
        code: 'unsupported',
        errmsg: 'Live bars are not available for oanda 7s; /getbars still serves its history',
        vendor: 'oanda',
        symbol: 'EURUSD',
        interval: '7s'
      })
      expect(seen.at(-1)).toEqual([
        {
          kind: 'bars',
          label: 'oanda EURUSD 7s',
          code: 'unsupported',
          errmsg: 'Live bars are not available for oanda 7s; /getbars still serves its history'
        }
      ])
      expect(errors).not.toHaveBeenCalled()
      sockets[0].receive({
        type: 'subscribed',
        vendor: 'oanda',
        symbol: 'EURUSD',
        interval: '7s',
        updates: 'all',
        formingSupported: false,
        serverTime: 1
      })
      expect(seen.at(-1)).toEqual([])
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })

  test('of plugin points is recorded under the plugin and variant', () => {
    const [warnings, errors] = quiet()
    try {
      const client = new StreamClient()
      let last: { kind: string; label: string }[] = []
      client.onRefusals((r) => {
        last = r
      })
      client.subscribePlugin('arev', 'arev21', 'oanda', 'EURUSD', '1h', { onPoint: () => {} })
      sockets[0].open()
      sockets[0].receive({
        type: 'error',
        code: 'too_large',
        errmsg: 'This connection already holds the maximum of 64 live plugin subscriptions',
        plugin: 'arev',
        variant: 'arev21',
        vendor: 'oanda',
        symbol: 'EURUSD',
        interval: '1h'
      })
      expect(last.map((r) => [r.kind, r.label])).toEqual([['plugin', 'arev:arev21 oanda EURUSD 1h']])
      expect(errors).not.toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })

  test('of an indicator reaches its listener as an error status, by key or by document', () => {
    const [warnings, errors] = quiet()
    try {
      const client = new StreamClient()
      const statuses: [string, string | null][] = []
      const series = { name: 'rsi', params: { window: 14 } } as never
      client.subscribeIndicator('oanda', 'EURUSD', '1D', series, 'key-rsi', {
        onPoint: () => {},
        onStatus: (phase, error) => statuses.push([phase, error])
      })
      sockets[0].open()
      sockets[0].receive({ type: 'error', code: 'invalid_request', errmsg: 'backfill must be an integer in 0..500', seriesKey: 'key-rsi' })
      sockets[0].receive({
        type: 'error',
        code: 'not_found',
        errmsg: 'no such indicator',
        vendor: 'oanda',
        symbol: 'EURUSD',
        interval: '1D',
        indicator: { name: 'rsi', params: { window: 14 } }
      })
      expect(statuses).toEqual([
        ['error', 'invalid_request: backfill must be an integer in 0..500'],
        ['error', 'not_found: no such indicator']
      ])
      expect(errors).not.toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })

  test('is forgotten when the socket reconnects, since every subscribe is sent again', async () => {
    const [warnings, errors] = quiet()
    try {
      const client = new StreamClient()
      let last: unknown[] = []
      client.onRefusals((r) => {
        last = r
      })
      client.subscribe('oanda', 'EURUSD', '7s', barListener().listener)
      sockets[0].open()
      sockets[0].receive({ type: 'error', code: 'unsupported', errmsg: 'no', vendor: 'oanda', symbol: 'EURUSD', interval: '7s' })
      expect(last).toHaveLength(1)
      sockets[0].drop(1006)
      await sleep(RECONNECT_WAIT_MS)
      sockets[1].open()
      expect(last).toEqual([])
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })

  test('an error naming no subscription this client holds is only logged', () => {
    const [warnings, errors] = quiet()
    try {
      const client = new StreamClient()
      let last: unknown[] = []
      client.onRefusals((r) => {
        last = r
      })
      client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
      sockets[0].open()
      sockets[0].receive({ type: 'error', code: 'unsupported', errmsg: 'no', vendor: 'oanda', symbol: 'GBPUSD', interval: '1h' })
      expect(last).toEqual([])
      expect(errors).toHaveBeenCalledTimes(1)
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })
})

describe('close 4401', () => {
  test('signs out once and stops reconnecting', async () => {
    storage.set(TOKEN_KEY, 'tok-1')
    let rejected = 0
    authtoken.whenSessionRejected(() => {
      rejected += 1
    })
    const warnings = spyOn(console, 'warn').mockImplementation(() => {})
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const statuses: string[] = []
      const client = new StreamClient()
      client.onStatus((s) => statuses.push(s))
      client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
      sockets[0].open()
      sockets[0].receive({ type: 'error', code: 'unauthorized', errmsg: 'Missing, invalid, or expired session token' })
      sockets[0].drop(4401, 'unauthorized')
      expect(rejected).toBe(1)
      expect(storage.has(TOKEN_KEY)).toBe(false)
      expect(statuses.at(-1)).toBe('offline')
      await sleep(RECONNECT_WAIT_MS)
      // A socket with no session would only be closed again: nothing is opened until the
      // page has signed in afresh.
      client.subscribe('oanda', 'GBPUSD', '1h', barListener().listener)
      expect(sockets).toHaveLength(1)
      expect(errors).not.toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })

  test('an ordinary drop reconnects and signs nobody out', async () => {
    storage.set(TOKEN_KEY, 'tok-1')
    let rejected = 0
    authtoken.whenSessionRejected(() => {
      rejected += 1
    })
    const client = new StreamClient()
    client.subscribe('oanda', 'EURUSD', '1h', barListener().listener)
    sockets[0].open()
    sockets[0].drop(1006)
    await sleep(RECONNECT_WAIT_MS)
    expect(sockets).toHaveLength(2)
    expect(rejected).toBe(0)
    expect(storage.get(TOKEN_KEY)).toBe('tok-1')
  })
})
