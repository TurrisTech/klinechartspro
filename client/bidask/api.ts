import { OhlcvApiError } from '../config'
import { isNoData, type OHLCVBar } from '../ohlcv'
import type { StreamListener } from '../stream'
import type { Page, PluginFacilities, Range, SourceNotify, SourceSpec, SourceStore } from '../plugins/types'
import type { WindowStore } from '../plugins/store'

// The bid/ask of every bar, read from `/getbars?columns=all`. Nothing new on the server:
// the store has always held the bid and ask OHLC beside the mid, `/getbars` passes them
// through with `columns=all` -- from Postgres, from the `side=bidask` tile partition on a
// tiered read, and folded open-first/high-max/low-min/close-last for a derived interval --
// and the chart's own bar path simply never asks for them (the browser reads mid tiles).
//
// "When the data is available" is decided per bar, from the values rather than from the
// vendor's name, because the columns are present everywhere: coinbase fills all eight with
// the trade OHLC and schwab with the mid (measured on dev and prod, 2026-09-17), so a
// column's presence says nothing. A bar carries a quote when all eight are numbers and the
// two sides differ somewhere. A real quote identical on all four prices of both sides does
// not happen on a bar that traded, so that test costs nothing on OANDA.

export interface QuotePoint {
  date: number
  bo: number
  bh: number
  bl: number
  bc: number
  ao: number
  ah: number
  al: number
  ac: number
}

const FIELDS = ['open', 'high', 'low', 'close'] as const

/** The quote half of a `/getbars` bar, or null when it has none worth drawing. */
export function quoteOf(bar: OHLCVBar & Record<string, unknown>): QuotePoint | null {
  const bid: number[] = []
  const ask: number[] = []
  for (const f of FIELDS) {
    const b = bar[`bid_${f}`]
    const a = bar[`ask_${f}`]
    if (typeof b !== 'number' || typeof a !== 'number' || !Number.isFinite(b) || !Number.isFinite(a)) return null
    bid.push(b)
    ask.push(a)
  }
  if (bid.every((b, i) => b === ask[i])) return null
  return { date: bar.date, bo: bid[0], bh: bid[1], bl: bid[2], bc: bid[3], ao: ask[0], ah: ask[1], al: ask[2], ac: ask[3] }
}

export function quoteSourceKey(vendor: string, ticker: string, interval: string): string {
  return `bidask|${vendor}:${ticker}|${interval}`
}

/** How long the forming bar's quote may go unrefreshed while ticks arrive. The stream
 * carries only the mid, so the forming bar's bid/ask is whatever the feed last wrote. */
export const FORMING_REFRESH_MS = 15_000

/** Bars per page, as a share of the server's cap: a page is sized by nominal duration, and
 * a dense span must not trip the 413. The split below catches the rest. */
const PAGE_SHARE = 0.8

export function quoteSource(
  f: PluginFacilities,
  vendor: string,
  ticker: string,
  interval: string,
  maxBarsPerRequest: number
): SourceSpec<QuotePoint> {
  const symbol = `${vendor}:${ticker}`
  const barMs = Math.max(1, f.resolutionDurationMs(interval))

  const read = async (from: number, to: number): Promise<QuotePoint[]> => {
    try {
      // The chart's range is on the wire clock and so is `/getbars`'s window; `to` is
      // exclusive there, as it is in the host's ranges. No `limit`: it keeps the LAST n
      // bars, the wrong end for a page that continues forwards.
      const body = await f.api.get<OHLCVBar[] | { s: 'no_data' }>('/getbars', { symbol, resolution: interval, from, to, columns: 'all' })
      if (isNoData(body) || !Array.isArray(body)) return []
      const out: QuotePoint[] = []
      for (const bar of body) {
        const q = quoteOf(bar as OHLCVBar & Record<string, unknown>)
        if (q) out.push(q)
      }
      return out
    } catch (err) {
      if (err instanceof OhlcvApiError && err.code === 'too_large' && to - from > barMs) {
        const mid = from + Math.floor((to - from) / 2)
        const [a, b] = await Promise.all([read(from, mid), read(mid, to)])
        return [...a, ...b]
      }
      throw err
    }
  }

  return {
    id: 'quote',
    key: quoteSourceKey(vendor, ticker, interval),
    resolution: interval,
    fetch: async (range: Range): Promise<Page<QuotePoint>> => {
      const span = Math.max(barMs, Math.floor(maxBarsPerRequest * PAGE_SHARE) * barMs)
      const end = Math.min(range.to, range.from + span)
      const points = await read(range.from, end)
      return { points, nextFrom: end < range.to ? end : null }
    },
    // The live half. The stream's bars are mid-only, so a frame is a cue to re-read, not a
    // value: a closed bar forgets itself and everything after it (what was held for it was a
    // prefix), and a forming one does the same at most every FORMING_REFRESH_MS. The host
    // then fetches exactly what was forgotten. A replay wall's stream is inert, so none of
    // this reaches a replay's store.
    subscribe: (store: SourceStore<QuotePoint>, notify: SourceNotify) => {
      let lastForming = 0
      const forget = (date: number) => {
        // Coverage is forgotten, the values are kept until the re-read replaces them: dropping
        // them too would blank the newest bar's quote for the length of a round trip, every
        // FORMING_REFRESH_MS.
        const s = store as WindowStore<QuotePoint>
        const kept = [...s.values].filter(([t]) => t >= date)
        s.forgetAfter(date)
        for (const [t, v] of kept) s.values.set(t, v)
        notify.refetch()
      }
      const listener: StreamListener = {
        onBar: (bar, closed) => {
          if (closed) {
            forget(bar.date)
            return
          }
          const now = Date.now()
          if (now - lastForming < FORMING_REFRESH_MS) return
          lastForming = now
          forget(bar.date)
        }
      }
      f.stream.subscribe(vendor, ticker, interval, listener)
      return () => f.stream.unsubscribe(vendor, ticker, interval, listener)
    }
  }
}
