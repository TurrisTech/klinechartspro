import { afterEach, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The alerts' reads of the server. One rule here so far: a graph answer the server could give only
// partly -- a timeframe it could not read (wdashboard-server 0.60.0) -- is a failed read for the
// alert engine, not an answer with no entries, because the engine keeps what it is told is final.

installWindow()
const { HttpAlertData } = await import('./data')

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const request = {
  symbol: 'oanda:EURUSD',
  source: 'arev21_outlier:arev21_outlier_rank',
  timeframes: ['3m', '5m', '4h', '1D'],
  roots: ['1D'],
  maxStep: 8,
  from: 1_000,
  to: 2_000
}

describe('HttpAlertData.graph', () => {
  test('a whole answer is the answer', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ s: 'no_data', nextFrom: null, computedThrough: 1_999 }), { status: 200 })) as unknown as typeof fetch
    const answer = await new HttpAlertData().graph(request)
    expect(answer.nodes).toEqual([])
    expect(answer.computedThrough).toBe(1_999)
  })

  test('a partial answer fails, naming what could not be read, so nothing of it is kept', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          s: 'ok',
          signals: [],
          nodes: [],
          unavailable: [{ interval: '4h', detail: 'OSError: 4h: index file read back empty' }],
          nextFrom: null,
          computedThrough: 1_999
        }),
        { status: 200 }
      )) as unknown as typeof fetch
    await expect(new HttpAlertData().graph(request)).rejects.toThrow('4h could not be read (OSError: 4h: index file read back empty)')
  })
})
