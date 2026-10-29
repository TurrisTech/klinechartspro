import { advertisedBaseIntervals, capabilities } from '../capabilities'
import { apiGet, OhlcvApiError, type QueryParams } from '../config'
import { getbarsSplit } from '../history'
import { isNoData, type OHLCVBar } from '../ohlcv'
import type { BarSource, Columns, ReplayBar } from './cache'
import { type CandleGrid, nominalMs, storedLadderFor } from './timeframes'

// GLUE. `BarSource` over `/getbars` -- the only module in client/replay that fetches bars. It
// reads PAST the page-wide read clock on purpose (`asof: null`): the caches are the replay's
// own look-ahead, hidden from the chart until the cursor reaches them -- every read the chart
// itself makes stays clamped by config.ts. The alert manager's look-ahead
// (client/alerts/data.ts) reads bars through this too. So does the probe of which intervals an
// instrument has stored (`probeStoredIntervals`), one bar per interval.

/** How far back the stored-ladder probe looks: a store's finest series may lag the newest
 * bar by days (a 5s backfill that stopped), and `limit=1` keeps the read to one bar. */
export const PROBE_WINDOW_MS = 10 * 86_400_000

/** What the probe reads with -- the server and `/capabilities` by default, fakes in a test. */
export interface StoredProbeDeps {
  get: <T>(path: string, params: QueryParams) => Promise<T>
  /** The intervals the server says a vendor stores, or null where it says nothing. */
  advertised: (vendor: string) => readonly string[] | null
}

const SERVER: StoredProbeDeps = { get: apiGet, advertised: advertisedBaseIntervals }

/** Which of the stored ladder the store holds for `symbol` (`vendor:ticker`) around `at`: of the
 * intervals its vendor stores (`storedLadderFor`), those with a bar in the window before `at`.
 * The answer is the replay's "stored" everywhere -- the bases it offers, the intervals a forming
 * candle is composed from, the refinement ladder of the fill engine -- so an interval the server
 * would only fold (schwab's 1h) is never asked about: its bar is there, and proves nothing. */
export async function probeStoredIntervals(symbol: string, at: number, grid: CandleGrid, deps: StoredProbeDeps = SERVER): Promise<string[]> {
  const vendor = symbol.includes(':') ? symbol.split(':', 1)[0] : 'oanda'
  const candidates = storedLadderFor(deps.advertised(vendor))
  // All at once, not one after another: they are independent one-bar reads, and the user is
  // waiting on the last of them (the start dialog, or the replay wall's mount).
  const held = await Promise.all(
    candidates.map(async (code) => {
      try {
        const shift = grid.toWire(code, at) - at
        const body = await deps.get<OHLCVBar[] | { s: 'no_data' }>('/getbars', {
          symbol,
          resolution: code,
          from: at - Math.max(PROBE_WINDOW_MS, 30 * nominalMs(code)) + shift,
          to: at + shift,
          limit: 1,
          asof: null
        })
        return Array.isArray(body) && body.length > 0 && !isNoData(body)
      } catch (err) {
        if (!(err instanceof OhlcvApiError)) throw err
        return false
      }
    })
  )
  return candidates.filter((_, i) => held[i])
}

/** A `/getbars` bar (columns=all) as a store-clock `ReplayBar`, on the instrument's schedule. */
export function toReplayBar(interval: string, bar: OHLCVBar & Record<string, unknown>, grid: CandleGrid): ReplayBar {
  const open = grid.fromWire(interval, bar.date)
  const out: ReplayBar = {
    open,
    end: grid.end(interval, open),
    date: bar.date,
    o: bar.open,
    h: bar.high,
    l: bar.low,
    c: bar.close,
    v: bar.volume
  }
  const side = (prefix: 'bid' | 'ask'): { o: number; h: number; l: number; c: number } | null => {
    const o = bar[`${prefix}_open`]
    const h = bar[`${prefix}_high`]
    const l = bar[`${prefix}_low`]
    const c = bar[`${prefix}_close`]
    if (typeof o === 'number' && typeof h === 'number' && typeof l === 'number' && typeof c === 'number') return { o, h, l, c }
    return null
  }
  const bid = side('bid')
  const ask = side('ask')
  if (bid && ask) {
    out.bid = bid
    out.ask = ask
  }
  return out
}

/** Bars per page: the server's cap, minus a margin so a window sized by nominal length
 * does not trip it on a dense span. */
function pageBars(): number {
  return Math.max(100, Math.floor(capabilities().limits.maxBarsPerRequest * 0.8))
}

export class HttpBarSource implements BarSource {
  async fetch(symbol: string, interval: string, from: number, to: number, columns: Columns, grid: CandleGrid): Promise<ReplayBar[]> {
    const out: ReplayBar[] = []
    const page = pageBars() * nominalMs(interval)
    let cursor = from
    while (cursor < to) {
      const end = Math.min(to, cursor + page)
      const bars = await this.fetchRange(symbol, interval, cursor, end, columns, grid)
      for (const b of bars) if (b.open >= cursor && b.open < end) out.push(b)
      cursor = end
    }
    return out
  }

  /** One range, split in halves on the server's 413 (a span denser than its nominal length
   * suggested -- 5s bars over a busy hour, say). */
  private async fetchRange(symbol: string, interval: string, from: number, to: number, columns: Columns, grid: CandleGrid): Promise<ReplayBar[]> {
    // `/getbars` takes `from`/`to` on the WIRE clock (session-dated for daily and coarser:
    // +7h forex, 0 crypto, -9h equities). Past the replay clock on purpose (`asof: null`): these
    // caches prefetch ahead of the cursor and are hidden from the chart.
    const shift = grid.toWire(interval, from) - from
    const bars = await getbarsSplit(apiGet, { symbol, resolution: interval, from: from + shift, to: to + shift - 1, columns, asof: null }, nominalMs(interval))
    return bars.map((b: OHLCVBar) => toReplayBar(interval, b as OHLCVBar & Record<string, unknown>, grid))
  }
}
