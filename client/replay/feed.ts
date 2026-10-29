import type { KLineData } from 'klinecharts'
import type { ChartProPane, Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '../../src'
import { fetchBarsWidened } from '../history'
import type { PluginStream, Range } from '../plugins/types'
import { periodToResolution } from '../periods'
import { fetchSymbols, symbolVendor } from '../symbols'
import { BarCache, type BarSource, type ComposeSpan, type ReplayBar, composeForming, composeLadder, composeSpans, nonWeekendGaps } from './cache'
import { type CandleGrid, gridFor, nominalMs } from './timeframes'

// GLUE (chart-facing). The replay wall's datafeed and the hub that pushes stepped bars into
// every pane. No stream: only this client moves the clock.
//
// History loads go through the ordinary `/getbars` path, which the page-wide read clock
// (config.ts) clamps to the cursor -- the server answers the closed bars plus the forming
// one. A window the chart asks for "ending now" is re-anchored to end at the cursor, so a
// pane opening a year back does not load an empty window and widen into nothing.
//
// Stepping pushes through the pane's subscribe callback -- klinecharts' updateData path,
// which appends a bar newer than the last and replaces one at the same timestamp. The hub
// NEVER keeps a watermark of its own: what to push is computed from the chart's actual
// last bar (`chart.getDataList()`), and after every push the chart's tail is asserted
// against what was pushed. A jump too large to append reloads the pane's window at the new
// cursor instead (a clean seek), never an incremental push of hundreds of bars.

export const HISTORY_WINDOW_BARS = 500

/** Above this many whole bars to append, a pane is reloaded at the cursor instead.
 *
 * Each bar handed to a pane recalculates every indicator on it over every bar it holds, and
 * lays it out (src/ChartPane.svelte `subscribeBar`): measured on a six-pane EURUSD wall carrying
 * the usual overlays (2026-10-26), about 2.4 ms a bar: a 10-hour Go to appending ~340 bars
 * across the panes stopped in 1.26 s, about 0.8 s of it handing bars over. A reload is one read of the
 * pane's window and one recalculation; with the threshold at 60 the same jump stopped in 0.34 s.
 * 100 sits about where the two cost the same on that wall with prod's round trip; it was 300. */
export const SEEK_THRESHOLD_BARS = 100

/** Whether a push from `previous` to `cursor` reloads a pane whose last bar opened at `lastOpen`,
 * rather than appending to it: the jump, from the later of the two, is longer than the append
 * threshold. The one rule both the push and the landing it is predicted for (`landingRange`)
 * follow. */
function reloads(interval: string, lastOpen: number, previous: number, cursor: number): boolean {
  const nominal = Math.max(1, Math.floor((cursor - Math.max(lastOpen, previous)) / nominalMs(interval)))
  return nominal > SEEK_THRESHOLD_BARS
}

export class ReplayDatafeed implements Datafeed {
  private readonly callbacks = new Map<string, DatafeedSubscribeCallback>()

  constructor(private readonly hub: ReplayFeedHub) {}

  async searchSymbols(search?: string): Promise<SymbolInfo[]> {
    try {
      return await fetchSymbols(search ?? '')
    } catch (err) {
      console.error('[replay] symbol search failed', err)
      return []
    }
  }

  async getHistoryKLineData(symbol: SymbolInfo, period: Period, from: number, to: number, direction: 'older' | 'newer' = 'older'): Promise<KLineData[]> {
    const vendor = symbolVendor(symbol)
    const interval = periodToResolution(period)
    const cursor = this.hub.cursor
    // A window ending after the cursor (ChartPane's "now") is re-anchored to end at it.
    let f = from
    let t = to
    if (t > cursor) {
      const span = t - f
      t = cursor
      f = t - span
    }
    this.hub.loadsInFlight++
    try {
      return await fetchBarsWidened(`${vendor}:${symbol.ticker}`, interval, f, t, direction === 'older' ? HISTORY_WINDOW_BARS : null, direction)
    } catch (err) {
      console.error('[replay] history fetch failed', err)
      return []
    } finally {
      this.hub.loadsInFlight--
    }
  }

  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    this.callbacks.set(feedKey(symbolVendor(symbol), symbol.ticker, periodToResolution(period)), callback)
  }

  unsubscribe(symbol: SymbolInfo, period: Period): void {
    this.callbacks.delete(feedKey(symbolVendor(symbol), symbol.ticker, periodToResolution(period)))
  }

  /** The pane's live callback for a key, if it is subscribed. */
  callbackFor(vendor: string, ticker: string, interval: string): DatafeedSubscribeCallback | undefined {
    return this.callbacks.get(feedKey(vendor, ticker, interval))
  }
}

export function feedKey(vendor: string, ticker: string, interval: string): string {
  return `${vendor}:${ticker}|${interval}`
}

export interface PushReport {
  paneId: string
  key: string
  /** Whole bars appended (or replaced) on the chart. */
  pushed: number
  /** Whether a forming bar was pushed. */
  forming: boolean
  /** The pane was reloaded at the cursor instead of appended to. */
  reloaded: boolean
  /** Contiguity assertion outcome: null when it held. */
  problem: string | null
}

/** Which of the stored ladder the store holds for an instrument around `at`. */
export type StoredProbe = (symbol: string, at: number, grid: CandleGrid) => Promise<string[]>

/** Owns the pane caches and the per-symbol caches the forming bars are composed from, and
 * pushes stepped bars into the wall's panes. */
export class ReplayFeedHub {
  cursor: number
  /** History loads the panes have in flight through the replay's datafeed: a pane reloaded at the
   * cursor is loading its bars, and its plugins have not asked for anything yet. What the next
   * landing's warm-up waits out (landing.ts). */
  loadsInFlight = 0
  private readonly paneCaches = new Map<string, BarCache>()
  /** Per instrument and interval of its compose ladder (`composeLadder`): the base, and the
   * stored intervals between it and the panes'. */
  private readonly composeCaches = new Map<string, BarCache>()
  /** Per instrument, what the store holds -- set for the walked one, probed for the others. */
  private readonly stored = new Map<string, Promise<readonly string[]>>()

  constructor(
    private readonly source: BarSource,
    private base: string,
    cursor: number,
    /** How an instrument the hub was not told about is probed; without one it composes from
     * the base alone. */
    private readonly probe: StoredProbe | null = null
  ) {
    this.cursor = cursor
  }

  /** What the store holds for `symbol` (the walked instrument's ladder, probed at start). */
  setStored(symbol: string, intervals: readonly string[]): void {
    this.stored.set(symbol, Promise.resolve(intervals))
  }

  createFeed(): ReplayDatafeed {
    return new ReplayDatafeed(this)
  }

  get baseInterval(): string {
    return this.base
  }

  setBase(base: string): void {
    if (base === this.base) return
    this.base = base
    for (const c of this.composeCaches.values()) c.dump()
    this.composeCaches.clear()
  }

  /** Dump every cache (a symbol or interval change on the wall, or a large jump). */
  dumpAll(): void {
    for (const c of this.paneCaches.values()) c.dump()
    for (const c of this.composeCaches.values()) c.dump()
    this.paneCaches.clear()
    this.composeCaches.clear()
  }

  private paneCache(symbol: string, interval: string, grid: CandleGrid): BarCache {
    const key = `${symbol}|${interval}`
    let c = this.paneCaches.get(key)
    if (!c) {
      c = new BarCache(this.source, symbol, interval, grid, 'core')
      this.paneCaches.set(key, c)
    }
    return c
  }

  private composeCache(symbol: string, interval: string, grid: CandleGrid): BarCache {
    const key = `${symbol}|${interval}`
    let c = this.composeCaches.get(key)
    if (!c) {
      c = new BarCache(this.source, symbol, interval, grid, 'core')
      this.composeCaches.set(key, c)
    }
    return c
  }

  /** What the store holds for `symbol`: as set, or probed once at the cursor. A probe that
   * fails composes from the base alone. */
  private storedFor(symbol: string, grid: CandleGrid): Promise<readonly string[]> {
    let held = this.stored.get(symbol)
    if (!held) {
      const probe = this.probe
      held = probe
        ? probe(symbol, this.cursor, grid).catch((err) => {
            console.warn(`[replay] could not probe the stored intervals of ${symbol}; composing from the base`, err)
            return []
          })
        : Promise.resolve([])
      this.stored.set(symbol, held)
    }
    return held
  }

  /** The spans the forming candle of `interval` opening at `bucketOpen` takes its bars from. */
  private async formingSpans(symbol: string, interval: string, bucketOpen: number, grid: CandleGrid): Promise<ComposeSpan[]> {
    const ladder = composeLadder(interval, this.base, await this.storedFor(symbol, grid))
    return composeSpans(bucketOpen, this.cursor, ladder, grid)
  }

  /** After the cursor moved from `previous` to `this.cursor`: bring every pane up to the
   * cursor -- whole bars appended from the pane cache, the forming bar composed from the
   * coarsest stored bars that fit -- or reload the pane when the span is too long to append. */
  async push(panes: readonly ChartProPane[], previous: number): Promise<PushReport[]> {
    // A pane too far behind to append to is reloaded at the cursor, and before anything is read:
    // its reload is the pane's own read of its window, and needs none of the bars the other
    // panes' forming candles are composed from. Sent after them, it waited a round trip (a Next
    // alert landing on prod: the 5m and 3m panes' reloads went out 150-200 ms after the press).
    const reports = new Map<ChartProPane, PushReport | null>()
    for (const pane of panes) {
      const reloaded = this.reloadIfFar(pane, previous)
      if (reloaded) reports.set(pane, reloaded)
    }
    const appending = panes.filter((pane) => !reports.has(pane))
    // Every other pane at once: each reads its own bars, and one after another a six-pane wall
    // paid six round trips per step. The bars the forming bars are composed from are shared by
    // every pane of an instrument, so they are read first, once -- a pane reading them itself
    // would re-anchor a shared cache under another's read.
    await this.coverForming(appending)
    await Promise.all(appending.map(async (pane) => reports.set(pane, await this.pushPane(pane))))
    // Let go of bars no pane's forming bucket can still need -- each pane's bucket on its own
    // instrument's schedule.
    const opens = panes.flatMap((p) => {
      const grid = gridFor(p.getSymbol())
      return grid ? [grid.start(periodToResolution(p.getPeriod()), Math.max(this.cursor - 1, 0))] : []
    })
    const earliest = Math.min(...opens)
    if (Number.isFinite(earliest)) for (const c of this.composeCaches.values()) c.trimBefore(earliest)
    return panes.map((pane) => reports.get(pane)).filter((r): r is PushReport => r !== null && r !== undefined)
  }

  /** Reload `pane` at the cursor when the jump since its last bar is longer than the append
   * threshold, and say so; null for a pane to append to (or one `pushPane` reports on). */
  private reloadIfFar(pane: ChartProPane, previous: number): PushReport | null {
    const held = this.held(pane)
    if (!held || !reloads(held.interval, held.grid.fromWire(held.interval, held.last), previous, this.cursor)) return null
    const symbolInfo = pane.getSymbol()
    const vendor = symbolVendor(symbolInfo)
    this.reload(pane, `${vendor}:${symbolInfo.ticker}`, held.interval, held.grid)
    return { paneId: pane.id, key: feedKey(vendor, symbolInfo.ticker, held.interval), pushed: 0, forming: false, reloaded: true, problem: null }
  }

  /**
   * The bars `pane` will hold once a push brings it from the hub's cursor to `at`, as the plugin
   * host reads a chart's range: from its first bar's date to just past its last one's. What a
   * bar replay warms its next landing over (`PluginHost.warmAhead`), so it is worked out by the
   * same rule the push follows (`reloads`):
   * - a jump past the append threshold reloads the pane at the cursor, into ChartPane's 500-bar
   *   window ending there (`ReplayDatafeed.getHistoryKLineData`). Its first bar is taken at the
   *   window's start, at or before the first one the reload will hold, so a window worked out
   *   from it holds everything the pane will ask for;
   * - anything shorter keeps the pane's bars and appends up to the bar open at `at`: forming
   *   there, or closing on it.
   *
   * Null for a pane a push would leave as it is: no bars, no subscription, no schedule.
   */
  landingRange(pane: ChartProPane, at: number): Range | null {
    const held = this.held(pane)
    if (!held) return null
    const { interval, grid } = held
    const to = grid.toWire(interval, grid.start(interval, at - 1)) + 1
    if (reloads(interval, grid.fromWire(interval, held.last), this.cursor, at)) return { from: at - HISTORY_WINDOW_BARS * nominalMs(interval), to }
    return { from: held.first, to }
  }

  /** What a push needs to know about `pane` before reading anything: its interval and schedule,
   * and its first and last bars' dates. Null for a pane it cannot push to. */
  private held(pane: ChartProPane): { interval: string; grid: CandleGrid; first: number; last: number } | null {
    const symbolInfo = pane.getSymbol()
    const interval = periodToResolution(pane.getPeriod())
    const feed = pane.getDatafeed() as ReplayDatafeed
    if (typeof feed?.callbackFor !== 'function' || !feed.callbackFor(symbolVendor(symbolInfo), symbolInfo.ticker, interval)) return null
    let data: KLineData[]
    try {
      data = pane.getChart().getDataList()
    } catch {
      return null
    }
    const first = data[0]?.timestamp
    const last = data.at(-1)?.timestamp
    const grid = gridFor(symbolInfo)
    if (first === undefined || last === undefined || !grid) return null
    return { interval, grid, first, last }
  }

  /** Read, per instrument and compose interval, the one range every forming candle of its
   * panes takes from it -- all of them at once. A 1D pane at 06:00 on a 5s base reads 1h bars
   * from 17:00, 1m bars from 06:00 and 5s bars from the last whole minute; not 5s bars from
   * 17:00, nor (after a jump) from wherever the previous cursor was. */
  private async coverForming(panes: readonly ChartProPane[]): Promise<void> {
    const ranges = new Map<string, { symbol: string; grid: CandleGrid } & ComposeSpan>()
    await Promise.all(
      panes.map(async (pane) => {
        const info = pane.getSymbol()
        const grid = gridFor(info)
        if (!grid) return
        const symbol = `${symbolVendor(info)}:${info.ticker}`
        const interval = periodToResolution(pane.getPeriod())
        const bucketOpen = grid.start(interval, this.cursor - 1)
        if (bucketOpen >= this.cursor) return
        for (const span of await this.formingSpans(symbol, interval, bucketOpen, grid)) {
          const key = `${symbol}|${span.interval}`
          const held = ranges.get(key)
          if (!held) ranges.set(key, { symbol, grid, ...span })
          else {
            held.from = Math.min(held.from, span.from)
            held.to = Math.max(held.to, span.to)
          }
        }
      })
    )
    await Promise.all([...ranges.values()].map((r) => this.composeCache(r.symbol, r.interval, r.grid).cover(r.from, r.to)))
  }

  private async pushPane(pane: ChartProPane): Promise<PushReport | null> {
    const symbolInfo = pane.getSymbol()
    const vendor = symbolVendor(symbolInfo)
    const ticker = symbolInfo.ticker
    const interval = periodToResolution(pane.getPeriod())
    const symbol = `${vendor}:${ticker}`
    const key = feedKey(vendor, ticker, interval)
    const feed = pane.getDatafeed() as ReplayDatafeed
    const callback = typeof feed?.callbackFor === 'function' ? feed.callbackFor(vendor, ticker, interval) : undefined
    let chart: ReturnType<ChartProPane['getChart']>
    try {
      chart = pane.getChart()
    } catch {
      return null
    }
    const data = chart.getDataList()
    // A COUNT, not the array: getDataList() hands back the chart's live list, which the
    // pushes below mutate in place.
    const countBefore = data.length
    const last = data.at(-1)?.timestamp
    const base: PushReport = { paneId: pane.id, key, pushed: 0, forming: false, reloaded: false, problem: null }
    if (!callback || last === undefined) return { ...base, problem: callback ? null : 'no subscription' }
    // The pane's OWN instrument's schedule: a coinbase pane beside an FX one closes its days
    // at UTC midnight, not 17:00 New York. With none resolved there is no honest label for a
    // forming bar -- and the server could not have served the pane any bars either.
    const grid = gridFor(symbolInfo)
    if (!grid) return { ...base, problem: `no market hours for ${symbol}` }
    const cursor = this.cursor
    const lastOpen = grid.fromWire(interval, last)
    // (A jump longer than the append threshold was reloaded already: `reloadIfFar`.)

    // Whole bars: every stored bar of the interval opening at or after the chart's last bar
    // (the last may be the previously forming bar, now closed: its final version replaces
    // it) and closed by the cursor.
    const cache = this.paneCache(symbol, interval, grid)
    await cache.cover(lastOpen, cursor)
    const whole = cache.slice(lastOpen, cursor).filter((b) => b.end <= cursor)
    if (whole.length > SEEK_THRESHOLD_BARS) {
      this.reload(pane, symbol, interval, grid)
      return { ...base, reloaded: true }
    }
    const gaps = nonWeekendGaps(interval, [{ open: lastOpen, end: lastOpen, date: last, o: 0, h: 0, l: 0, c: 0, v: 0 }, ...whole], grid)
    let expectedLast = last
    for (const b of whole) {
      callback(toKLine(b))
      expectedLast = b.date
    }
    // The forming bar: the bucket containing the cursor, composed from the stored bars inside
    // it that closed by the cursor, coarsest first. Its label is the same open `/getbars`
    // labels the whole bar with.
    let forming = false
    const bucketOpen = grid.start(interval, cursor - 1)
    if (bucketOpen < cursor && (whole.length === 0 || bucketOpen > whole[whole.length - 1].open) && bucketOpen >= lastOpen) {
      const parts: ReplayBar[] = []
      for (const span of await this.formingSpans(symbol, interval, bucketOpen, grid)) {
        const c = this.composeCache(symbol, span.interval, grid)
        await c.cover(span.from, span.to)
        for (const b of c.slice(span.from, span.to)) if (b.end <= cursor) parts.push(b)
      }
      const bar = composeForming(interval, bucketOpen, parts, grid)
      if (bar) {
        callback(toKLine(bar))
        expectedLast = bar.date
        forming = true
      }
    }
    cache.trimBefore(bucketOpen)

    // Contiguity: the chart's tail must be exactly what was pushed, and the run must have
    // no gap that is not the weekend (stored data can skip a dead minute; that is reported,
    // not fatal).
    const after = chart.getDataList()
    const tail = after.at(-1)?.timestamp
    let problem: string | null = null
    if (tail !== expectedLast) problem = `chart tail ${tail} != pushed ${expectedLast}`
    else if (after.length < countBefore + whole.length - (whole[0]?.open === lastOpen ? 1 : 0)) problem = `chart grew by ${after.length - countBefore}, pushed ${whole.length}`
    if (problem) console.error(`[replay] contiguity failed on ${key}: ${problem}`)
    else if (gaps.length > 0) console.warn(`[replay] ${key}: ${gaps.length} non-weekend gap(s) in stored data`, gaps)
    return { ...base, pushed: whole.length, forming, problem }
  }

  private reload(pane: ChartProPane, symbol: string, interval: string, grid: CandleGrid): void {
    // The pane's init load runs through getHistoryKLineData, which ends its window at the
    // cursor; the pane cache is re-anchored there, lazily.
    this.paneCache(symbol, interval, grid).seek(this.cursor - HISTORY_WINDOW_BARS * nominalMs(interval))
    try {
      pane.getChart().resetData()
    } catch (err) {
      console.warn('[replay] reload failed', err)
    }
  }
}

export function toKLine(bar: ReplayBar): KLineData {
  return { timestamp: bar.date, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }
}

/** The stream a replay wall hands the plugins: nothing live ever arrives. Only this client
 * moves the clock, and a live point would be a value from the future. */
export const inertStream: PluginStream = {
  subscribe() {},
  unsubscribe() {},
  subscribeIndicator() {},
  unsubscribeIndicator() {},
  subscribePlugin() {},
  unsubscribePlugin() {}
}
