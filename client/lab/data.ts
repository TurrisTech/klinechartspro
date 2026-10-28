// WHERE A RUN'S DATA COMES FROM, held for the page so that editing a rule and pressing Run again
// costs no request at all -- refinement is many runs over the same bars.
//
//   bars     core OHLC through the tiled history path (client/history.ts: tiles for the closed
//            periods, `/getbars` for the rest); with bid/ask (`columns=all`) through the replay's
//            bar source, for the simulated fills
//   signals  `GET /plugins/{id}/signals` -- only the labelled points, which is what makes a long
//            window of 3m signals cheap (a year of rank-85 5m reads in under a second)
//   points   `GET /plugins/{id}/values`, for a stored series or a signal an alert-language rule
//            reads (alerts/data.ts, which this reuses)
//
// Every read is PAST any replay clock (`asof: null`), like an alert's look-ahead: a run is history.
// Each series is one contiguous span per key (`TailCache`), extended from either end as windows
// grow -- and its last few bars read AGAIN whenever it is extended forward: a span read up to
// "now" ends on a bar still forming, which a closed-bars read leaves out and a signals read finds
// no label on, so extending from the old end alone would leave that bar out for good.

import { HttpAlertData, type Point } from '../alerts/data'
import type { PointSource } from '../alerts/compute'
import { capabilities } from '../capabilities'
import { apiGet } from '../config'
import { fetchBars } from '../history'
import type { ReplayBar } from '../replay/cache'
import { TiledBarSource } from '../replay/tiled'
import { type CandleGrid, nominalMs } from '../replay/timeframes'
import { fetchSymbolInfo } from '../symbols'
import type { SignalPoint } from './events'

export interface SignalRequest {
  plugin: string
  variant: string
  params: Record<string, number>
}

export interface LabData {
  grid(symbol: string): Promise<CandleGrid | null>
  /** One pip in price; for an instrument not priced in pips, one unit of its last decimal. */
  pip(symbol: string): Promise<number>
  /** Bars of `interval` opening in `[from, to)` (store clock), ascending, closed only. */
  bars(symbol: string, interval: string, from: number, to: number, columns: 'core' | 'all'): Promise<ReplayBar[]>
  /** A plugin's LABELLED points dated in `[from, to)` (wire dates), ascending. */
  signals(request: SignalRequest, symbol: string, interval: string, from: number, to: number): Promise<SignalPoint[]>
  /** A plugin's points dated in `[from, to)` (wire dates). */
  points(source: PointSource, symbol: string, interval: string, from: number, to: number): Promise<Point[]>
}

/** Nominal bars per `/getbars` page: under the server's cap even where a span is dense. */
const PAGE_BARS = 4000

/** Pages one signals read follows before it stops: a runaway cursor must not crawl forever. */
const MAX_PAGES = 400

/** Bars at the end of a span read again when it is extended forward. */
const TAIL_BARS = 4

/** One contiguous run of rows keyed by an ascending number (a bar's open, a point's date), read
 * on demand from either end; extending it forward reads its last `tailMs` again (see above). A
 * range that does not touch the run replaces it: two runs with a hole between would read as one
 * with nothing in the hole. */
export class TailCache<R> {
  private rows: R[] = []
  private lo: number | null = null
  private hi: number | null = null

  constructor(
    private readonly fetch: (from: number, to: number) => Promise<R[]>,
    private readonly keyOf: (row: R) => number,
    private readonly tailMs: number
  ) {}

  async ensure(from: number, to: number): Promise<void> {
    if (to <= from) return
    if (this.lo === null || this.hi === null || to < this.lo || from > this.hi) {
      this.rows = await this.fetch(from, to)
      this.lo = from
      this.hi = to
      return
    }
    if (from < this.lo) {
      const lo = this.lo
      const before = await this.fetch(from, lo)
      this.rows = [...before.filter((r) => this.keyOf(r) < lo), ...this.rows]
      this.lo = from
    }
    if (to > this.hi) {
      const edge = Math.max(this.lo, this.hi - this.tailMs)
      const after = await this.fetch(edge, to)
      this.rows = [...this.rows.filter((r) => this.keyOf(r) < edge), ...after.filter((r) => this.keyOf(r) >= edge)]
      this.hi = to
    }
  }

  slice(from: number, to: number): R[] {
    return this.rows.filter((r) => {
      const key = this.keyOf(r)
      return key >= from && key < to
    })
  }
}

export class HttpLabData implements LabData {
  private readonly alertData = new HttpAlertData()
  private readonly barSource = new TiledBarSource()
  private readonly bars_ = new Map<string, TailCache<ReplayBar>>()
  private readonly signals_ = new Map<string, TailCache<SignalPoint>>()
  private readonly points_ = new Map<string, TailCache<Point>>()
  private readonly pips = new Map<string, Promise<number>>()

  grid(symbol: string): Promise<CandleGrid | null> {
    return this.alertData.grid(symbol)
  }

  pip(symbol: string): Promise<number> {
    let pip = this.pips.get(symbol)
    if (!pip) {
      const at = symbol.indexOf(':')
      pip = fetchSymbolInfo(symbol.slice(at + 1), symbol.slice(0, at))
        .then((info) => info.pipSize ?? 10 ** -(info.pricePrecision ?? 2))
        .catch(() => 0.0001)
      this.pips.set(symbol, pip)
    }
    return pip
  }

  async bars(symbol: string, interval: string, from: number, to: number, columns: 'core' | 'all'): Promise<ReplayBar[]> {
    const grid = await this.grid(symbol)
    if (!grid || to <= from) return []
    const key = `${symbol}|${interval}|${columns}`
    let cache = this.bars_.get(key)
    if (!cache) {
      cache = new TailCache<ReplayBar>(
        (a, b) => (columns === 'all' ? this.barSource.fetch(symbol, interval, a, b, 'all', grid) : this.coreBars(symbol, interval, a, b, grid)),
        (bar) => bar.open,
        TAIL_BARS * nominalMs(interval)
      )
      this.bars_.set(key, cache)
    }
    await cache.ensure(from, to)
    return cache.slice(from, to)
  }

  /** Core bars through the tiled path, paged so the API half stays under its cap. */
  private async coreBars(symbol: string, interval: string, from: number, to: number, grid: CandleGrid): Promise<ReplayBar[]> {
    const out: ReplayBar[] = []
    const page = PAGE_BARS * nominalMs(interval)
    for (let cursor = from; cursor < to; cursor += page) {
      const end = Math.min(to, cursor + page)
      // fetchBars speaks the wire clock (session-dated for daily and coarser).
      const bars = await fetchBars(symbol, interval, grid.toWire(interval, cursor), grid.toWire(interval, end), null)
      for (const bar of bars) {
        const open = grid.fromWire(interval, bar.timestamp)
        if (open < cursor || open >= end) continue
        out.push({ open, end: grid.end(interval, open), date: bar.timestamp, o: bar.open, h: bar.high, l: bar.low, c: bar.close, v: bar.volume ?? 0 })
      }
    }
    return out
  }

  async signals(request: SignalRequest, symbol: string, interval: string, from: number, to: number): Promise<SignalPoint[]> {
    if (to <= from) return []
    const key = `${request.plugin}|${request.variant}|${JSON.stringify(request.params)}|${symbol}|${interval}`
    let cache = this.signals_.get(key)
    if (!cache) {
      cache = new TailCache<SignalPoint>((a, b) => readSignals(request, symbol, interval, a, b), (p) => p.date, TAIL_BARS * nominalMs(interval))
      this.signals_.set(key, cache)
    }
    await cache.ensure(from, to)
    return cache.slice(from, to)
  }

  async points(source: PointSource, symbol: string, interval: string, from: number, to: number): Promise<Point[]> {
    if (to <= from) return []
    const key = `${source.plugin}|${source.variant}|${symbol}|${interval}`
    let cache = this.points_.get(key)
    if (!cache) {
      cache = new TailCache<Point>((a, b) => this.alertData.points(source, symbol, interval, a, b), (p) => p.date, TAIL_BARS * nominalMs(interval))
      this.points_.set(key, cache)
    }
    await cache.ensure(from, to)
    return cache.slice(from, to)
  }
}

interface SignalsEnvelope {
  s: string
  points?: SignalPoint[]
  nextFrom?: number | null
}

/** `GET /plugins/{id}/signals` over `[from, to)`, every page. A server still building the series
 * (`replaying`) or holding none (`no_data`) answers nothing here: an empty pool is a legitimate
 * answer, and the run says how many signals each source produced. */
async function readSignals(request: SignalRequest, symbol: string, interval: string, from: number, to: number): Promise<SignalPoint[]> {
  const out: SignalPoint[] = []
  const limit = capabilities().limits.maxBarsPerRequest
  let cursor = from
  for (let page = 0; cursor < to && page < MAX_PAGES; page++) {
    const body = await apiGet<SignalsEnvelope>(`/plugins/${encodeURIComponent(request.plugin)}/signals`, {
      symbol,
      resolution: interval,
      from: cursor,
      to,
      limit,
      variant: request.variant || undefined,
      params: Object.keys(request.params).length > 0 ? JSON.stringify(request.params) : undefined,
      asof: null
    })
    if (body.s !== 'ok' || !Array.isArray(body.points)) break
    for (const point of body.points) if (point.date >= cursor && point.date < to) out.push(point)
    const next = body.nextFrom ?? null
    if (next === null || next <= cursor) break
    cursor = next
  }
  return out.sort((a, b) => a.date - b.date)
}
