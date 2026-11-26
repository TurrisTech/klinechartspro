import { describe, expect, test } from 'bun:test'
import { forwardedClose, forwardHeaders } from './devproxy'

// client/serve.ts proxies /ohlcv (REST and WS /stream) to a real server in local dev. With the
// login enforced on every route, the proxy has to pass the bearer through on HTTP, and pass
// the server's close code through on the socket -- 4401 is how the server says the session is
// gone, and a proxy that closes with its own code would hide that from the browser.

describe('forwardHeaders', () => {
  test('passes Authorization through and drops the origin-bound headers', () => {
    const req = new Request('http://localhost:3000/ohlcv/getbars', {
      headers: {
        Authorization: 'Bearer tok',
        Host: 'localhost:3000',
        Origin: 'http://localhost:3000',
        Referer: 'http://localhost:3000/',
        Connection: 'keep-alive',
        'X-Sim-Owner': 'owner-1'
      }
    })
    const headers = forwardHeaders(req)
    expect(headers.get('authorization')).toBe('Bearer tok')
    expect(headers.get('x-sim-owner')).toBe('owner-1')
    for (const name of ['host', 'origin', 'referer', 'connection']) expect(headers.has(name)).toBe(false)
  })
})

describe('forwardedClose', () => {
  test("the server's application codes reach the browser with their reason", () => {
    expect(forwardedClose(4401, 'unauthorized')).toEqual([4401, 'unauthorized'])
    expect(forwardedClose(1000, '')).toEqual([1000, ''])
    expect(forwardedClose(1011, 'boom')).toEqual([1011, 'boom'])
  })

  test('codes no endpoint may send become a plain close', () => {
    // 1005 (no status) and 1006 (abnormal) describe what the proxy SAW; sending them is an error.
    expect(forwardedClose(1005, '')).toEqual([])
    expect(forwardedClose(1006, '')).toEqual([])
    expect(forwardedClose(1015, '')).toEqual([])
    expect(forwardedClose(999, '')).toEqual([])
    expect(forwardedClose(5000, '')).toEqual([])
  })

  test('a reason longer than a close frame allows is cut to fit', () => {
    const [, reason] = forwardedClose(4401, 'x'.repeat(200)) as [number, string]
    expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(123)
  })
})
