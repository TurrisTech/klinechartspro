import { afterAll, describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'

// The live datafeed hands a reconnect's backfill to the pane in ONE call -- only the part newer
// than what the chart holds -- so a pane following the live edge can reload rather than take
// hundreds of bars one full recalculation at a time (ChartPane `subscribeBar`). A tick is still
// one bar.

const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  navigator: { userAgent: 'test' }
}
const pristineFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = pristineFetch
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

const H = 3_600_000
const T0 = Date.UTC(2026, 8, 23, 10)
const bar = (i: number) => ({ date: T0 + i * H, open: 1, high: 1, low: 1, close: 1, volume: 1 })
// History holds bars 0..9; nothing is tiled and the instrument has no schedule to filter on.
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const url = input instanceof URL ? input : new URL(String(input))
  if (!url.pathname.endsWith('/getbars')) return new Response('not found', { status: 404 })
  return Response.json(Array.from({ length: 10 }, (_, i) => bar(i)))
}) as typeof fetch

const { stream } = await import('./stream')
const { WdashboardDatafeed } = await import('./datafeed')
import type { StreamListener } from './stream'

describe('the live datafeed', () => {
  test('a backfill is one call carrying only what is newer than the chart; a tick is one bar', async () => {
    let listener: StreamListener | null = null
    const realSubscribe = stream.subscribe
    stream.subscribe = ((_v: string, _s: string, _i: string, l: StreamListener) => {
      listener = l
    }) as typeof stream.subscribe
    try {
      const feed = new WdashboardDatafeed()
      const symbol = { ticker: 'ZZZFEED', exchange: 'oanda' } as never
      const period = { multiplier: 1, timespan: 'hour', text: '1h' }
      await feed.getHistoryKLineData(symbol, period, T0 - H, T0 + 10 * H)
      const calls: Array<KLineData | readonly KLineData[]> = []
      feed.subscribe(symbol, period, (data) => calls.push(data))
      const l = listener as unknown as StreamListener
      l.onBackfill?.(Array.from({ length: 40 }, (_, i) => bar(i)))
      expect(calls).toHaveLength(1)
      expect((calls[0] as KLineData[]).map((b) => b.timestamp)).toEqual(Array.from({ length: 31 }, (_, i) => T0 + (i + 9) * H))
      l.onBar?.(bar(40), false)
      expect((calls[1] as KLineData).timestamp).toBe(T0 + 40 * H)
      // Nothing new: no call at all.
      l.onBackfill?.([bar(3), bar(4)])
      expect(calls).toHaveLength(2)
    } finally {
      stream.subscribe = realSubscribe
    }
  })
})
