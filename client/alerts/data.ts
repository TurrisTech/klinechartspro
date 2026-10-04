// WHERE AN ALERT'S DATA COMES FROM: stored bars (`/getbars`) and plugin points
// (`/plugins/{id}/values`), both read PAST any replay clock (`asof: null`). On a replay wall
// the page-wide clock clamps every read to the cursor, and an alert's look-ahead is exactly
// what must not be clamped -- it is hidden from the chart until the cursor reaches it, as the
// replay's own bar caches are. A live alert reads past it too: it watches the live market
// whatever wall is on screen.
//
// `SpanCache` holds one contiguous run per series and extends it from either end, so a search
// that walks forward a chunk at a time, and the next search that starts where it stopped,
// fetch each bar once.

import { capabilities } from '../capabilities'
import { fetchPoints } from '../plugins/api'
import { HttpBarSource } from '../replay/source'
import { type CandleGrid, gridFor } from '../replay/timeframes'
import { fetchSymbolInfo } from '../symbols'
import type { AlertBar, PointSource } from './compute'

export type Point = { date: number } & Record<string, unknown>

export interface AlertData {
  /** The instrument's candle schedule -- where its bars open and close, which is when every
   * value on them becomes knowable -- or null when the server resolved no market hours for it.
   * An instrument with none cannot be evaluated: there is no instant to evaluate at. */
  grid(symbol: string): Promise<CandleGrid | null>
  /** Bars of `interval` opening in `[from, to)` (store clock), ascending, on the instrument's
   * own schedule; none for an instrument with no schedule. */
  bars(symbol: string, interval: string, from: number, to: number): Promise<AlertBar[]>
  /** A plugin's points dated in `[from, to)` (wire dates, as the bars carry them), ascending. */
  points(source: PointSource, symbol: string, interval: string, from: number, to: number): Promise<Point[]>
}

/** The most pages one points read follows before it stops: a runaway `nextFrom` must not turn
 * one alert into an unbounded crawl. */
const MAX_POINT_PAGES = 200

export class HttpAlertData implements AlertData {
  private readonly source = new HttpBarSource()
  private readonly grids = new Map<string, Promise<CandleGrid | null>>()

  /** Read once per instrument per page, from the market hours `/instrument` resolves. */
  grid(symbol: string): Promise<CandleGrid | null> {
    let grid = this.grids.get(symbol)
    if (!grid) {
      const at = symbol.indexOf(':')
      grid = fetchSymbolInfo(symbol.slice(at + 1), symbol.slice(0, at))
        .then((info) => gridFor(info))
        .catch(() => null)
      this.grids.set(symbol, grid)
    }
    return grid
  }

  async bars(symbol: string, interval: string, from: number, to: number): Promise<AlertBar[]> {
    const grid = await this.grid(symbol)
    if (!grid) return []
    return this.source.fetch(symbol, interval, from, to, 'core', grid)
  }

  async points(source: PointSource, symbol: string, interval: string, from: number, to: number): Promise<Point[]> {
    const out: Point[] = []
    const limit = capabilities().limits.maxBarsPerRequest
    let cursor = from
    for (let page = 0; cursor < to && page < MAX_POINT_PAGES; page++) {
      const answer = await fetchPoints<Point>({
        pluginId: source.plugin,
        vendorSymbol: symbol,
        resolution: interval,
        from: cursor,
        to,
        limit,
        variant: source.variant || undefined,
        asof: null
      })
      for (const point of answer.points) if (point.date >= cursor && point.date < to) out.push(point)
      if (answer.nextFrom === null || answer.nextFrom <= cursor) break
      cursor = answer.nextFrom
    }
    return out
  }
}

/** One contiguous run of rows keyed by an ascending number (a bar's open, a point's date),
 * fetched on demand from either end. */
export class SpanCache<R> {
  private rows: R[] = []
  private lo: number | null = null
  private hi: number | null = null

  constructor(
    private readonly fetch: (from: number, to: number) => Promise<R[]>,
    private readonly keyOf: (row: R) => number
  ) {}

  /** Make `[from, to)` held, fetching only what is not. A range that does not touch the run
   * replaces it: two runs with a hole between would read as one with nothing in the hole. */
  async ensure(from: number, to: number): Promise<void> {
    if (to <= from) return
    if (this.lo === null || this.hi === null || to < this.lo || from > this.hi) {
      this.rows = await this.fetch(from, to)
      this.lo = from
      this.hi = to
      return
    }
    if (from < this.lo) {
      const before = await this.fetch(from, this.lo)
      this.rows = [...before.filter((r) => this.keyOf(r) < (this.lo as number)), ...this.rows]
      this.lo = from
    }
    if (to > this.hi) {
      const after = await this.fetch(this.hi, to)
      const edge = this.hi
      this.rows.push(...after.filter((r) => this.keyOf(r) >= edge))
      this.hi = to
    }
  }

  /** Held rows keyed in `[from, to)`. */
  slice(from: number, to: number): R[] {
    return this.rows.filter((r) => {
      const key = this.keyOf(r)
      return key >= from && key < to
    })
  }

  /** Forget everything keyed before `at`. */
  trimBefore(at: number): void {
    if (this.lo === null || at <= this.lo) return
    this.rows = this.rows.filter((r) => this.keyOf(r) >= at)
    this.lo = at
  }

  get size(): number {
    return this.rows.length
  }
}
