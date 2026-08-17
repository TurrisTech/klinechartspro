import type { KLineData } from 'klinecharts'
import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '../src'
import { fetchBarsWidened } from './history'
import { barToKLineData, type OHLCVBar } from './ohlcv'
import { periodToResolution } from './periods'
import { stream, subscriptionKey, type StreamListener } from './stream'
import { fetchSymbols, symbolVendor } from './symbols'

// KLineChart Pro asks for history one window at a time and caps a window at 500 bars
// (ChartPro.svelte's adjustFromTo call), so this is the widest reply that can ever be
// useful — and it keeps every /getbars under the server's per-request bar cap.
const HISTORY_WINDOW_BARS = 500

// Implements KLineChart Pro's Datafeed contract against wdashboard-server's OHLCV API:
// history from `GET /getbars` (with empty-trading-gap widening, see history.ts), symbol
// search from `GET /search`, and live updates from the page-wide shared `WS /stream`
// client (stream.ts).
export class WdashboardDatafeed implements Datafeed {
  // The newest bar timestamp handed to the chart per subscription key. It is what makes the
  // stream's backfill frame safe to forward: klinecharts' updateData only understands a bar
  // at or after the last one it holds, so a 200-bar backfill replayed wholesale would be
  // rejected bar by bar — or worse, rewrite the tail out of order. Only the part of the
  // backfill strictly newer than what the chart already has is the actual gap.
  private readonly latest = new Map<string, number>()
  private readonly listeners = new Map<string, StreamListener>()

  async searchSymbols(search?: string): Promise<SymbolInfo[]> {
    try {
      return await fetchSymbols(search ?? '')
    } catch (err) {
      console.error('[datafeed] symbol search failed', err)
      return []
    }
  }

  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number,
    direction: 'older' | 'newer' = 'older'
  ): Promise<KLineData[]> {
    const vendor = symbolVendor(symbol)
    const interval = periodToResolution(period)
    try {
      const bars = await fetchBarsWidened(
        `${vendor}:${symbol.ticker}`,
        interval,
        from,
        to,
        // 'newer' (ChartPane's backward-paging branch) already bounds [from, to] to one
        // narrow nominal page -- passing a limit here would let the server's tail(limit)
        // trim the wrong (near) edge on the rare widened-and-dense case; see history.ts.
        direction === 'older' ? HISTORY_WINDOW_BARS : null,
        direction
      )
      const newest = bars.at(-1)?.timestamp
      if (newest !== undefined) {
        const key = subscriptionKey(vendor, symbol.ticker, interval)
        this.latest.set(key, Math.max(this.latest.get(key) ?? 0, newest))
      }
      return bars
    } catch (err) {
      // Never reject: KLineChartPro awaits this with no catch, and a rejection strands its
      // internal loading flags — permanently killing pagination and symbol/period
      // switching. An empty batch degrades gracefully instead.
      console.error('[datafeed] history fetch failed', err)
      return []
    }
  }

  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    const vendor = symbolVendor(symbol)
    const interval = periodToResolution(period)
    const key = subscriptionKey(vendor, symbol.ticker, interval)

    const emit = (bar: OHLCVBar, closed: boolean): void => {
      const latest = this.latest.get(key) ?? 0
      // Strictly-older bars only. Equality must pass through, and for both kinds: a closed
      // bar at `latest` is the final version of the bar the chart is holding open, and a
      // forming bar at `latest` is that same bar still ticking. Only `<` is stale history.
      if (bar.date < latest) return
      // Forming bars deliberately do not advance the watermark — the bar is not settled, so
      // a later backfill covering it must still be allowed through.
      if (closed) this.latest.set(key, bar.date)
      callback(barToKLineData(bar))
    }

    const listener: StreamListener = {
      onBackfill: (bars) => {
        for (const bar of bars) emit(bar, true)
      },
      onBar: (bar, closed) => emit(bar, closed)
    }

    this.listeners.set(key, listener)
    stream.subscribe(vendor, symbol.ticker, interval, listener)
  }

  unsubscribe(symbol: SymbolInfo, period: Period): void {
    const vendor = symbolVendor(symbol)
    const interval = periodToResolution(period)
    const key = subscriptionKey(vendor, symbol.ticker, interval)
    const listener = this.listeners.get(key)
    if (!listener) return
    this.listeners.delete(key)
    this.latest.delete(key)
    stream.unsubscribe(vendor, symbol.ticker, interval, listener)
  }
}
