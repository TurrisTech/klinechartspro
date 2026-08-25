import { capabilities } from '../capabilities'
import { apiGet, OhlcvApiError } from '../config'
import { isNoData, type OHLCVBar } from '../ohlcv'
import { fetchSignals } from '../plugins/api'
import type { BarSource, Columns, ReplayBar } from './cache'
import type { SignalHit, SignalSource } from './signals'
import { fromWireDate, intervalEnd, nominalMs } from './timeframes'

// GLUE. `BarSource` and `SignalSource` over `/getbars` and `/plugins/{id}/signals`. The only
// module in client/replay that fetches. Both read PAST the page-wide read clock on purpose
// (`asof: null`): the caches and the signal book are the replay's own look-ahead, hidden from
// the chart until the cursor reaches them -- every read the chart itself makes stays clamped
// by config.ts.

/** A `/getbars` bar (columns=all) as a store-clock `ReplayBar`. */
export function toReplayBar(interval: string, bar: OHLCVBar & Record<string, unknown>): ReplayBar {
  const open = fromWireDate(interval, bar.date)
  const out: ReplayBar = {
    open,
    end: intervalEnd(interval, open),
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
  async fetch(symbol: string, interval: string, from: number, to: number, columns: Columns): Promise<ReplayBar[]> {
    const out: ReplayBar[] = []
    const page = pageBars() * nominalMs(interval)
    let cursor = from
    while (cursor < to) {
      const end = Math.min(to, cursor + page)
      const bars = await this.fetchRange(symbol, interval, cursor, end, columns)
      for (const b of bars) if (b.open >= cursor && b.open < end) out.push(b)
      cursor = end
    }
    return out
  }

  /** One range, split in halves on the server's 413 (a span denser than its nominal
   * length suggested -- 5s bars over a busy hour, say). */
  private async fetchRange(symbol: string, interval: string, from: number, to: number, columns: Columns): Promise<ReplayBar[]> {
    // `/getbars` takes `from`/`to` on the WIRE clock (session-dated for daily and coarser).
    const shift = from - fromWireDate(interval, from)
    try {
      const body = await apiGet<OHLCVBar[] | { s: 'no_data' }>('/getbars', {
        symbol,
        resolution: interval,
        from: from + shift,
        to: to + shift - 1,
        columns,
        asof: null
      })
      if (isNoData(body) || !Array.isArray(body)) return []
      return body.map((b) => toReplayBar(interval, b as OHLCVBar & Record<string, unknown>))
    } catch (err) {
      if (err instanceof OhlcvApiError && err.code === 'too_large' && to - from > nominalMs(interval)) {
        const mid = from + Math.floor((to - from) / 2)
        const [a, b] = await Promise.all([this.fetchRange(symbol, interval, from, mid, columns), this.fetchRange(symbol, interval, mid, to, columns)])
        return [...a, ...b]
      }
      throw err
    }
  }
}

export class HttpSignalSource implements SignalSource {
  async points(ref: string, symbol: string, resolution: string, from: number, to: number): Promise<SignalHit[]> {
    const out: SignalHit[] = []
    let cursor = from
    const limit = capabilities().limits.maxBarsPerRequest
    for (let pages = 0; cursor < to && pages < 50; pages++) {
      const page = await fetchSignals<{ date: number }>({
        ref,
        vendorSymbol: symbol,
        resolution,
        from: cursor,
        to,
        limit,
        asof: null
      })
      for (const p of page.points) out.push({ date: p.date, effective: p.effective })
      if (page.nextFrom === null || page.nextFrom <= cursor) break
      cursor = page.nextFrom
    }
    return out
  }
}
