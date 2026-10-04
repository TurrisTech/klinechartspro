// "WHERE DOES THIS ALERT NEXT TRIGGER?" -- what a bar replay's Next alert asks of every enabled
// alert on its instrument (client/replay/alerts.ts).
//
// It looks AHEAD of the cursor, a chunk of bars at a time, so a rule that next holds in a week
// costs a week of bars and not the rest of the data. Each chunk is evaluated with the lead-in
// its indicators need (./catalogue.ts `leadInBars`) and the firing policy is carried from one
// chunk to the next (./timeline.ts `scan`), so the answer does not depend on where a chunk
// happened to start.
//
// The instants at or before `after` are evaluated too -- an edge trigger and a crossing compare
// against them -- but cannot be the answer. So a rule already holding at the cursor is not
// "next": with `edge` the next answer is where it starts holding again, and with `level` it is
// the next bar close at which it holds.

import { resolutionDurationMs } from '../periods'
import { byInterval, leadInFor, type ServerCatalogue } from './catalogue'
import { type AlertBar, buildTrack, indexPoints, type PointIndex, type PointSource } from './compute'
import { type AlertData, type Point, SpanCache } from './data'
import { compile, operandKey } from './rules'
import { freshRun, type Instant, instants, scan, type Track } from './timeline'
import type { Alert, Operand } from './types'

/** Bars of the finest timeframe a rule reads, per chunk of a search. */
export const SEARCH_CHUNK_BARS = 3000

/** Rows held per series before a search trims what it has walked past. */
const MAX_HELD_ROWS = 60_000

/** Days added to every lead-in: a span measured in nominal bar lengths crosses weekends and
 * holidays that hold no bars, so it is padded rather than trusted. */
const LEAD_PAD_MS = 4 * 86_400_000

export interface AlertHit {
  alert: Alert
  /** The bar close it triggers at: the effective instant. */
  at: number
  instant: Instant
}

export interface SearchOptions {
  /** Asked between chunks: true abandons the search (it answers null). */
  shouldStop?: () => boolean
  /** How far the search has looked, after each chunk. */
  onProgress?: (reached: number) => void
}

/** Where a server operand's points come from, or null when the catalogue has no such row (a
 * registry entry removed since the alert was written) -- the operand then reads as missing. */
export function pointSource(operand: Operand, catalogue: ServerCatalogue): PointSource | null {
  if (operand.kind === 'series') {
    const row = catalogue.stored.find((s) => s.entry.name === operand.indicator)
    return row ? { plugin: row.plugin, variant: row.variant, foldBy: row.foldBy } : null
  }
  if (operand.kind === 'signal') return { plugin: operand.plugin, variant: operand.variant, foldBy: null }
  return null
}

function sourceKey(source: PointSource, symbol: string, interval: string): string {
  return `${source.plugin}|${source.variant}|${symbol}|${interval}`
}

export class AlertSearch {
  private readonly bars = new Map<string, SpanCache<AlertBar>>()
  private readonly points = new Map<string, SpanCache<Point>>()

  constructor(
    private readonly data: AlertData,
    private readonly catalogue: () => Promise<ServerCatalogue>
  ) {}

  /** Forget every fetched row (the instrument changed). */
  reset(): void {
    this.bars.clear()
    this.points.clear()
  }

  /** The first bar close in `(after, until]` at which `alert` triggers -- or null when it does
   * not before `until`, when its rule no longer compiles, or when `shouldStop` says so. */
  async next(alert: Alert, after: number, until: number, options: SearchOptions = {}): Promise<AlertHit | null> {
    let compiled: ReturnType<typeof compile>
    try {
      compiled = compile(alert.rule)
    } catch {
      return null
    }
    const operands = [...compiled.operands.values()]
    const groups = byInterval(operands)
    const intervals = [...groups.keys()]
    if (intervals.length === 0) return null
    const catalogue = operands.some((o) => o.kind === 'series' || o.kind === 'signal') ? await this.catalogue() : null
    const lengths = intervals.map(resolutionDurationMs)
    const chunk = SEARCH_CHUNK_BARS * Math.min(...lengths)
    // Where evaluation starts: a few of the coarsest bars before `after`, which is enough to
    // know what the cursor's own instant answered (the edge) and read (the crossings) -- and
    // each of those instants gets a full lead-in of its own below.
    const evalFrom = after - 3 * Math.max(...lengths)
    const fetchFrom = new Map(
      intervals.map((i) => [i, evalFrom - 2 * leadInFor(operands, i) * resolutionDurationMs(i) - LEAD_PAD_MS])
    )

    const state = freshRun()
    let processed = evalFrom
    while (processed < until) {
      if (options.shouldStop?.()) return null
      const chunkEnd = Math.min(until, Math.max(processed, after) + chunk)
      const tracks: Track[] = []
      for (const [interval, group] of groups) {
        const bars = this.barCache(alert.symbol, interval)
        const from = fetchFrom.get(interval) as number
        await bars.ensure(from, chunkEnd)
        // The bars this chunk reads: from `lead` bars before the one its first instant reads
        // (the last bar closed by then), to every bar opening before its end. One whose close
        // is past the end stays held for the next chunk's instants.
        const held = bars.slice(from, chunkEnd)
        const lead = leadInFor(operands, interval)
        const first = held.findIndex((b) => b.end > processed)
        const window = held.slice(Math.max(0, (first < 0 ? held.length : first) - 1 - lead))
        const index = await this.pointIndexes(alert.symbol, interval, group.values(), window, catalogue)
        tracks.push(await buildTrack(interval, window, group.values(), (o) => index.get(operandKey(o))))
        if (bars.size > MAX_HELD_ROWS && window.length > 0) {
          // Walked past: drop it, and stop asking for it -- `ensure` from the old start would
          // fetch it all again.
          bars.trimBefore(window[0].open)
          fetchFrom.set(interval, window[0].open)
        }
      }
      const hit = scan(compiled.condition, alert.trigger, instants(tracks, compiled.fields, processed, chunkEnd), after, until, state)
      if (hit) return { alert, at: hit.at, instant: hit }
      processed = chunkEnd
      options.onProgress?.(processed)
    }
    return null
  }

  private barCache(symbol: string, interval: string): SpanCache<AlertBar> {
    const key = `${symbol}|${interval}`
    let cache = this.bars.get(key)
    if (!cache) {
      cache = new SpanCache((from, to) => this.data.bars(symbol, interval, from, to), (bar) => bar.open)
      this.bars.set(key, cache)
    }
    return cache
  }

  /** The points every server operand on `interval` reads, over the dates of `window`. */
  private async pointIndexes(
    symbol: string,
    interval: string,
    operands: Iterable<Operand>,
    window: readonly AlertBar[],
    catalogue: ServerCatalogue | null
  ): Promise<Map<string, PointIndex>> {
    const out = new Map<string, PointIndex>()
    if (!catalogue || window.length === 0) return out
    const from = window[0].date
    const to = window[window.length - 1].date + 1
    for (const operand of operands) {
      const source = pointSource(operand, catalogue)
      if (!source) continue
      const key = sourceKey(source, symbol, interval)
      let cache = this.points.get(key)
      if (!cache) {
        cache = new SpanCache((a, b) => this.data.points(source, symbol, interval, a, b), (p) => p.date)
        this.points.set(key, cache)
      }
      await cache.ensure(from, to)
      out.set(operandKey(operand), indexPoints(cache.slice(from, to), source.foldBy))
      if (cache.size > MAX_HELD_ROWS) cache.trimBefore(from)
    }
    return out
  }
}

/** The earliest hit among `alerts` in `(after, until]`. Each search is bounded by the best
 * found so far, so one alert that triggers soon spares the rest a long look. */
export async function earliestHit(
  search: AlertSearch,
  alerts: readonly Alert[],
  after: number,
  until: number,
  options: SearchOptions = {}
): Promise<AlertHit | null> {
  let best: AlertHit | null = null
  for (const alert of alerts) {
    if (options.shouldStop?.()) return null
    const hit = await search.next(alert, after, best ? best.at : until, options)
    if (hit && (!best || hit.at < best.at)) best = hit
  }
  return best
}
