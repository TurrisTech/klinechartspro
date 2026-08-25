import type { KLineData } from 'klinecharts'
import type { ChartProPane, Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '../../src'
import { fetchBarsWidened } from '../history'
import type { PluginStream } from '../plugins/types'
import { periodToResolution } from '../periods'
import { fetchSymbols, symbolVendor } from '../symbols'
import { BarCache, type BarSource, type ReplayBar, composeForming, nonWeekendGaps } from './cache'
import { fromWireDate, intervalStart, nominalMs } from './timeframes'

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

/** Above this many whole bars to append, a pane is reloaded at the cursor instead. */
export const SEEK_THRESHOLD_BARS = 300

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
    try {
      return await fetchBarsWidened(`${vendor}:${symbol.ticker}`, interval, f, t, direction === 'older' ? HISTORY_WINDOW_BARS : null, direction)
    } catch (err) {
      console.error('[replay] history fetch failed', err)
      return []
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

/** Owns the pane caches and the per-symbol base caches the forming bars are composed from,
 * and pushes stepped bars into the wall's panes. */
export class ReplayFeedHub {
  cursor: number
  private readonly paneCaches = new Map<string, BarCache>()
  private readonly baseCaches = new Map<string, BarCache>()

  constructor(
    private readonly source: BarSource,
    private base: string,
    cursor: number
  ) {
    this.cursor = cursor
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
    for (const c of this.baseCaches.values()) c.dump()
    this.baseCaches.clear()
  }

  /** Dump every cache (a symbol or interval change on the wall, or a large jump). */
  dumpAll(): void {
    for (const c of this.paneCaches.values()) c.dump()
    for (const c of this.baseCaches.values()) c.dump()
    this.paneCaches.clear()
    this.baseCaches.clear()
  }

  private paneCache(symbol: string, interval: string): BarCache {
    const key = `${symbol}|${interval}`
    let c = this.paneCaches.get(key)
    if (!c) {
      c = new BarCache(this.source, symbol, interval, 'core')
      this.paneCaches.set(key, c)
    }
    return c
  }

  private baseCache(symbol: string): BarCache {
    let c = this.baseCaches.get(symbol)
    if (!c) {
      c = new BarCache(this.source, symbol, this.base, 'core')
      this.baseCaches.set(symbol, c)
    }
    return c
  }

  /** After the cursor moved from `previous` to `this.cursor`: bring every pane up to the
   * cursor -- whole bars appended from the pane cache, the forming bar composed from base
   * bars -- or reload the pane when the span is too long to append. */
  async push(panes: readonly ChartProPane[], previous: number): Promise<PushReport[]> {
    const reports: PushReport[] = []
    for (const pane of panes) {
      const report = await this.pushPane(pane, previous)
      if (report) reports.push(report)
    }
    // Let go of base bars no pane's forming bucket can still need.
    const earliest = Math.min(...panes.map((p) => intervalStart(periodToResolution(p.getPeriod()), Math.max(this.cursor - 1, 0))))
    if (Number.isFinite(earliest)) for (const c of this.baseCaches.values()) c.trimBefore(earliest)
    return reports
  }

  private async pushPane(pane: ChartProPane, previous: number): Promise<PushReport | null> {
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
    const cursor = this.cursor
    const lastOpen = fromWireDate(interval, last)

    // A jump longer than the append threshold: reload the pane's window at the cursor.
    const nominal = Math.max(1, Math.floor((cursor - Math.max(lastOpen, previous)) / nominalMs(interval)))
    if (nominal > SEEK_THRESHOLD_BARS) {
      this.reload(pane, symbol, interval)
      return { ...base, reloaded: true }
    }

    // Whole bars: every stored bar of the interval opening at or after the chart's last bar
    // (the last may be the previously forming bar, now closed: its final version replaces
    // it) and closed by the cursor.
    const cache = this.paneCache(symbol, interval)
    await cache.cover(lastOpen, cursor)
    const whole = cache.slice(lastOpen, cursor).filter((b) => b.end <= cursor)
    if (whole.length > SEEK_THRESHOLD_BARS) {
      this.reload(pane, symbol, interval)
      return { ...base, reloaded: true }
    }
    const gaps = nonWeekendGaps(interval, [{ open: lastOpen, end: lastOpen, date: last, o: 0, h: 0, l: 0, c: 0, v: 0 }, ...whole])
    let expectedLast = last
    for (const b of whole) {
      callback(toKLine(b))
      expectedLast = b.date
    }
    // The forming bar: the bucket containing the cursor, composed from base bars that
    // closed by the cursor. Its label is the same open `/getbars` labels the whole bar with.
    let forming = false
    const bucketOpen = intervalStart(interval, cursor - 1)
    if (bucketOpen < cursor && (whole.length === 0 || bucketOpen > whole[whole.length - 1].open) && bucketOpen >= lastOpen) {
      const baseCache = this.baseCache(symbol)
      await baseCache.cover(bucketOpen, cursor)
      const parts = baseCache.slice(bucketOpen, cursor).filter((b) => b.end <= cursor)
      const bar = composeForming(interval, bucketOpen, parts)
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

  private reload(pane: ChartProPane, symbol: string, interval: string): void {
    // The pane's init load runs through getHistoryKLineData, which ends its window at the
    // cursor; the pane cache is re-anchored there, lazily.
    this.paneCache(symbol, interval).seek(this.cursor - HISTORY_WINDOW_BARS * nominalMs(interval))
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
  onStatus(listener) {
    listener('offline')
    return () => {}
  }
}
