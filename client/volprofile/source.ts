import { getReadClock } from '../config'
import { fetchBars } from '../history'
import { missingRanges, mergeRange, truncate } from '../plugins/store'
import type { Page, Phase, PluginStream, Range, SourceNotify, SourceSpec, SourceStore } from '../plugins/types'
import {
  type DayGeometry,
  isInterval,
  nominalMs,
  parseInterval,
  scheduleIntervalStart,
  scheduleWireShift,
  sessionDated
} from '../replay/timeframes'
import type { StreamListener } from '../stream'
import { barsFromTiles } from '../tiles'
import { lowerBound, type SourceBar } from './atoms'

// Which bars the profile is built from, and reading them.
//
// THE SOURCE IS CHOSEN FOR THE PROFILE, NOT FOR THE CHART. A bar's range grows roughly with the
// square root of its duration, so a source bar spans about `chartRange * sqrt(source/chart)`,
// and the rule is that it should span no more than one display row -- beyond that the even
// spread (atoms.ts) is smearing volume across rows it never traded in, and finer than that
// costs bars without changing the picture. For a profile over the visible range that gives
// `source <= chart * visibleBars / rows^2`; for one per session, `source <= session / rows^2`,
// which is always the finest intraday base there is.
//
// Only STORED intervals are candidates (`baseIntervalsFor`, which differs per vendor: schwab
// keeps 30m and no 1h), because a derived one is folded out of a stored one's tiles and costs
// exactly as many bars. 5s is never picked: it exists only for the FX pairs it is fed for, and
// it is twelve times the bars of 1m for a resolution no profile needs.

/** How many bars a pane typically shows. Fixed rather than read off the zoom, so zooming does
 * not change the source and throw away what was fetched. */
export const NOMINAL_VISIBLE_BARS = 150

/** At most this many source bars are held for one pane; older chart bars are spread from
 * themselves instead (atoms.ts's remainder), and the legend says from when the source runs. */
export const MAX_SOURCE_BARS = 250_000

/** `/getbars` 413s past the server's cap (5000 by default); an API page stays under it. */
const API_PAGE_BARS = 4000
/** A page answered wholly from tiles is larger, but bounded so one page's market-closed
 * filtering (fetchBars) does not hold the main thread for long. */
const TILE_PAGE_BARS = 20_000

export type Mode = 'visible' | 'session'

/** The source interval for a profile on a `chart` pane, or null when the chart's own bars are
 * as fine as it needs (or nothing finer is stored). `override` is the pane's setting: a stored
 * interval no coarser than the chart, or 'auto'. */
export function pickSource(chart: string, bases: readonly string[], mode: Mode, rows: number, override = 'auto'): string | null {
  if (!isInterval(chart)) return null
  const chartMs = nominalMs(chart)
  const usable = bases
    .filter((b) => isInterval(b) && parseInterval(b).unit !== 's' && nominalMs(b) <= chartMs)
    .sort((a, b) => nominalMs(a) - nominalMs(b))
  let pick: string | null
  if (override !== 'auto' && usable.includes(override)) {
    pick = override
  } else {
    const n = Math.max(1, rows)
    const target = mode === 'session' ? nominalMs('1D') / (n * n) : (chartMs * NOMINAL_VISIBLE_BARS) / (n * n)
    pick = usable.findLast((b) => nominalMs(b) <= target) ?? usable[0] ?? null
  }
  return pick === chart ? null : pick
}

/** The instrument's schedule, as SymbolInfo carries it. */
export interface Schedule {
  timezone: string
  day: DayGeometry
}

/** The shift from a bar's wire date to its open instant for `interval`, or null when that
 * needs a schedule the chart was not given (a session-dated interval). */
export function wireShift(interval: string, schedule: Schedule | null): number | null {
  if (!sessionDated(interval)) return 0
  return schedule ? scheduleWireShift(interval, schedule.day) : null
}

/**
 * The source bars one profile reads, ascending and unique by date, plus the windows fetched.
 *
 * Not a `WindowStore`: the profile needs the bars in ORDER (a chart bar's source bars are a
 * slice, found by binary search) and needs to know WHAT changed, so a live tick rebuilds one
 * chart bar rather than the whole history. `changedSince` answers the second from a short log
 * of the earliest date each edit touched; a reader too far behind the log rebuilds everything.
 */
export class BarStore implements SourceStore<SourceBar> {
  readonly bars: SourceBar[] = []
  private ranges: Range[] = []
  phase: Phase = 'idle'
  progress: number | null = null
  error: string | null = null
  rev = 0
  private log: Array<{ rev: number; from: number }> = []
  /** Every edit at or before this rev has left the log. */
  private floor = 0

  constructor(readonly key: string) {}

  get size(): number {
    return this.bars.length
  }

  ingest(points: SourceBar[], window: Range): void {
    this.ranges = mergeRange(this.ranges, window)
    if (points.length > 0) {
      const sorted = [...points].sort((a, b) => a.date - b.date)
      this.merge(sorted)
      this.touch(sorted[0].date)
    } else {
      this.rev++
    }
  }

  /** One bar, replacing any held at its date -- the live path. */
  set(bar: SourceBar): void {
    const i = lowerBound(this.bars.length, bar.date, (j) => this.bars[j].date)
    if (i < this.bars.length && this.bars[i].date === bar.date) this.bars[i] = bar
    else this.bars.splice(i, 0, bar)
    this.touch(bar.date)
  }

  missing(window: Range): Range[] {
    return missingRanges(this.ranges, window)
  }

  forgetAfter(from: number): void {
    this.ranges = truncate(this.ranges, from)
    this.bars.length = lowerBound(this.bars.length, from, (j) => this.bars[j].date)
    this.touch(from)
  }

  setPhase(phase: Phase, progress: number | null = null, error: string | null = null): void {
    if (this.phase === phase && this.progress === progress && this.error === error) return
    this.phase = phase
    this.progress = progress
    this.error = error
    this.rev++
  }

  /** The earliest bar date changed since `rev`: null for none, -Infinity when the log no
   * longer reaches back that far. */
  changedSince(rev: number): number | null {
    if (rev < this.floor) return Number.NEGATIVE_INFINITY
    let min: number | null = null
    for (const e of this.log) if (e.rev > rev && (min === null || e.from < min)) min = e.from
    return min
  }

  private touch(from: number): void {
    this.rev++
    this.log.push({ rev: this.rev, from })
    if (this.log.length > 256) this.floor = (this.log.shift() as { rev: number }).rev
  }

  /** Merge ascending `points` in, a point replacing a held bar at the same date. Pages
   * usually land wholly before or after what is held, which is a concatenation. */
  private merge(points: SourceBar[]): void {
    const held = this.bars
    if (held.length === 0 || points[0].date > held[held.length - 1].date) {
      for (const p of points) held.push(p)
      return
    }
    if (points[points.length - 1].date < held[0].date) {
      held.unshift(...points)
      return
    }
    const out: SourceBar[] = []
    let i = 0
    let j = 0
    while (i < held.length || j < points.length) {
      if (j >= points.length || (i < held.length && held[i].date < points[j].date)) out.push(held[i++])
      else {
        if (i < held.length && held[i].date === points[j].date) i++
        out.push(points[j++])
      }
    }
    held.length = 0
    for (const b of out) held.push(b)
  }
}

/** The one factory for `vp-bars|` keys (plugins/README.md, "Two bindings on one key"). */
export function barStore(key: string): BarStore {
  return new BarStore(key)
}

export function barSourceKey(vendor: string, ticker: string, source: string): string {
  return `vp-bars|${vendor}:${ticker}|${source}`
}

/** Whether a bar dated `date` on `source`'s wire clock had closed by read clock `clock`. The
 * tiles are read straight from the bucket, so nothing on the server clamps them to a replay's
 * cursor (only `/getbars` is, through `apiUrl`); this is that clamp for this source. */
export function closedBy(source: string, date: number, clock: number, schedule: Schedule | null): boolean {
  if (!sessionDated(source)) return date + nominalMs(source) <= clock
  if (!schedule) return false
  const forming = scheduleIntervalStart(source, clock, schedule.timezone, schedule.day) + scheduleWireShift(source, schedule.day)
  return date < forming
}

export interface BarSourceOptions {
  stream: PluginStream
  vendor: string
  ticker: string
  source: string
  chart: string
  /** Wire date -> open instant, for the chart's bars and the source's. */
  chartShift: number
  sourceShift: number
  schedule: Schedule | null
}

function toSourceBar(bar: { timestamp?: number; date?: number; open: number; high: number; low: number; close: number; volume?: number | null }): SourceBar {
  return {
    date: (bar.timestamp ?? bar.date) as number,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: typeof bar.volume === 'number' && Number.isFinite(bar.volume) ? bar.volume : 0
  }
}

export function barSource(o: BarSourceOptions): SourceSpec<SourceBar> {
  const vendorSymbol = `${o.vendor}:${o.ticker}`
  const sourceMs = nominalMs(o.source)
  const chartMs = nominalMs(o.chart)
  return {
    id: 'bars',
    key: barSourceKey(o.vendor, o.ticker, o.source),
    resolution: o.source,
    createStore: barStore,
    // The chart's bars on the source's clock: from the first chart bar's open to past the end
    // of the last (the forming one), with a tenth of slack for calendar units whose nominal
    // length is short of the real one -- and no further back than the budget allows.
    window: (chartRange: Range): Range | null => {
      const from = chartRange.from - o.chartShift
      const lastOpen = chartRange.to - 1 - o.chartShift
      const to = lastOpen + Math.ceil(chartMs * 1.1) + 1
      const clipped = Math.max(from, to - MAX_SOURCE_BARS * sourceMs)
      return { from: clipped + o.sourceShift, to: to + o.sourceShift }
    },
    fetch: async (range: Range): Promise<Page<SourceBar>> => {
      // The window runs past the forming chart bar's end, which is in the future: nothing can
      // be read there yet, and the stream delivers it as it forms.
      const clock = getReadClock()
      if (range.from >= (clock ?? Date.now())) return { points: [], nextFrom: null }
      // Tiles first, in big pages; the API only for what they do not hold (the period still
      // forming), in pages under its cap. `fetchBars` does both halves and the market-closed
      // filter; asking it for a window the tiles cover means it never calls the API at all.
      const tiled = await barsFromTiles(vendorSymbol, o.source, range.from, range.to)
      const tiledTo = tiled ? tiled.coveredTo : range.from
      let end: number
      let next: number
      if (tiledTo > range.from) {
        next = Math.min(range.to, tiledTo, range.from + TILE_PAGE_BARS * sourceMs)
        // `fetchBars` answers from tiles alone only when they run strictly past its `to`; one
        // millisecond short of the tiles' edge holds no bar on any grid.
        end = next === tiledTo ? tiledTo - 1 : next
      } else {
        next = Math.min(range.to, range.from + API_PAGE_BARS * sourceMs)
        end = next
      }
      const bars = await fetchBars(vendorSymbol, o.source, range.from, end, null)
      const points: SourceBar[] = []
      for (const bar of bars) {
        if (clock !== null && !closedBy(o.source, bar.timestamp, clock, o.schedule)) continue
        points.push(toSourceBar(bar))
      }
      return { points, nextFrom: next < range.to ? next : null }
    },
    // The live half: the forming source bar and each close, so a developing profile moves with
    // the market. A replay wall's stream is inert, so nothing live reaches a replay's store --
    // and whatever the stream has not delivered yet, the chart bar's own volume covers
    // (atoms.ts's remainder).
    subscribe: (store: SourceStore<SourceBar>, notify: SourceNotify) => {
      const s = store as BarStore
      const listener: StreamListener = {
        onBackfill: (bars) => {
          for (const bar of bars) s.set(toSourceBar(bar))
          notify.changed()
        },
        onBar: (bar) => {
          s.set(toSourceBar(bar))
          notify.changed()
        }
      }
      o.stream.subscribe(o.vendor, o.ticker, o.source, listener)
      return () => o.stream.unsubscribe(o.vendor, o.ticker, o.source, listener)
    }
  }
}
