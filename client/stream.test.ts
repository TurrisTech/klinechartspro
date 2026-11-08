import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

// WS /stream presents the session in its FIRST frame, `{"action": "auth", "token": ...}` (a
// browser cannot set a header on a WebSocket handshake, and a token in the URL ends up in
// access logs), and sends its subscribes right behind it without waiting for the answer. A
// server from before the stream login answers that frame with an `Unknown action 'auth'`
// error and keeps the connection open, which must be invisible. A close with code 4401 is
// the server saying the session is gone.

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
    client.subscribeNotifications({ owner: 'owner-1', token: 'tok-1' }, () => {})
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

  test("today's server's Unknown action 'auth' error is swallowed and changes nothing", () => {
    storage.set(TOKEN_KEY, 'tok-1')
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const warnings = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let rejected = 0
      authtoken.whenSessionRejected(() => {
        rejected += 1
      })
      const statuses: string[] = []
      const client = new StreamClient()
      client.onStatus((s) => statuses.push(s))
      const { bars, listener } = barListener()
      client.subscribe('oanda', 'EURUSD', '1h', listener)
      sockets[0].open()
      // The wire as wdashboard-server <= 0.56 sends it (`errmsg`), and as ErrorBody spells it.
      sockets[0].receive({ type: 'error', code: 'invalid_request', errmsg: "Unknown action 'auth'" })
      sockets[0].receive({ type: 'error', code: 'invalid_request', detail: "Unknown action 'auth'" })
      sockets[0].receive({ type: 'subscribed', vendor: 'oanda', symbol: 'EURUSD', interval: '1h', formingSupported: true })
      sockets[0].receive({ type: 'bar', vendor: 'oanda', symbol: 'EURUSD', interval: '1h', closed: false, bar: { date: 1 } })
      expect(bars).toEqual([{ date: 1 }])
      expect(sockets[0].readyState).toBe(FakeSocket.OPEN)
      expect(statuses.at(-1)).toBe('connected')
      expect(errors).not.toHaveBeenCalled()
      expect(warnings).not.toHaveBeenCalled()
      expect(rejected).toBe(0)
      expect(storage.get(TOKEN_KEY)).toBe('tok-1')
    } finally {
      errors.mockRestore()
      warnings.mockRestore()
    }
  })

  test('another error is still reported', () => {
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
