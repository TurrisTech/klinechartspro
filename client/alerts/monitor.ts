// CLIENT ALERTS ON THE LIVE MARKET: evaluated in this tab, at every bar close, for as long as
// a dashboard tab is open. Page-level, not per wall: it keeps watching through a workspace
// switch and through a bar replay (whose clock is not the market's).
//
// Per instrument and timeframe a rule reads, one FEED: a history read deep enough for the
// rule's indicators to be warm (./catalogue.ts `leadInBars`), then the stream's CLOSED bars --
// a forming bar is never evaluated, because a value computed from it does not exist yet (the
// no-lookahead rule). Feeds are shared: two alerts on EURUSD 1h hold one subscription.
//
// An instant is evaluated once (`watermark`), in order, and never on history: what is already
// there when an alert starts is what its edge and crossings start from, exactly as arming a
// watch seeds its baseline. A server series (AREV's `p`, a signal) is written by another
// process some time after the bar closes, so an instant whose server value is still missing
// is WAITED for -- re-read every `pollMs` -- and evaluated anyway once `graceMs` has passed,
// with the value missing, which is unknowable and never fires (client/architecture note
// "freshness horizons": late and never cannot be told apart, so the wait is bounded).
//
// Bars of two timeframes closing at one instant arrive as two frames; evaluation waits
// `settleMs` after the last frame so they are evaluated together.

import type { NotificationSink } from '../notifications'
import type { OHLCVBar } from '../ohlcv'
import { resolutionDurationMs } from '../periods'
import { toReplayBar } from '../replay/source'
import type { CandleGrid } from '../replay/timeframes'
import type { StreamListener } from '../stream'
import { byInterval, labelOperand, leadInFor, type ServerCatalogue } from './catalogue'
import { type AlertBar, buildTrack, indexPoints, type PointIndex, type PointSource } from './compute'
import { evaluate } from './conditions'
import type { AlertData, Point } from './data'
import { compile, type CompiledRule, operandKey } from './rules'
import { pointSource } from './search'
import { type ClientAlertStore, signature } from './store'
import { freshRun, type Instant, instants, type RunState, stepInstant, type Track } from './timeline'
import type { Alert, Operand } from './types'

/** The stream, as much of it as the monitor uses -- the page's `stream` is one. */
export interface BarStream {
  subscribe(vendor: string, symbol: string, interval: string, listener: StreamListener): void
  unsubscribe(vendor: string, symbol: string, interval: string, listener: StreamListener): void
}

export interface MonitorOptions {
  store: ClientAlertStore
  notify: NotificationSink
  data: AlertData
  catalogue: () => Promise<ServerCatalogue>
  stream: BarStream
  now?: () => number
  /** Quiet time after a bar frame before evaluating (two timeframes closing together). */
  settleMs?: number
  /** How often an instant waiting on a server value re-reads it. */
  pollMs?: number
  /** How long an instant waits on a server value before it is evaluated without it. */
  graceMs?: number
}

const DEFAULT_SETTLE_MS = 1_500
const DEFAULT_POLL_MS = 30_000
const DEFAULT_GRACE_MS = 10 * 60_000
/** Closed bars a feed keeps beyond its lead-in. */
const FEED_TAIL_BARS = 300
/** Days added to a history read's nominal span, for the weekends it crosses. */
const HISTORY_PAD_MS = 4 * 86_400_000

/** One instrument at one timeframe: its closed bars, kept current by the stream. */
class Feed {
  bars: AlertBar[] = []
  /** How many bars of lead-in the history read has covered so far -- a runner needing more
   * waits for the deeper read rather than seeding on indicators that are not warm yet. */
  private loaded = 0
  /** The instrument's schedule, once read: what turns a streamed bar's label into its open and
   * close. Frames that arrive before it are held, not dropped. */
  private grid: CandleGrid | null = null
  private early: OHLCVBar[] = []
  private depth = 0
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly listener: StreamListener

  constructor(
    readonly symbol: string,
    readonly interval: string,
    private readonly owner: AlertMonitor
  ) {
    this.listener = {
      onBackfill: (bars) => this.merge(bars),
      onBar: (bar, closed) => {
        if (closed) this.merge([bar])
      }
    }
  }

  /** Whether the history covers `depth` bars of lead-in. */
  readyFor(depth: number): boolean {
    return this.loaded >= depth
  }

  /** When the bar after the newest one held will close, on the instrument's schedule; null
   * with nothing held. What lets an instant wait for a timeframe whose bar is due by then but
   * not here yet, instead of reading its previous bar. */
  nextClose(): number | null {
    const last = this.bars[this.bars.length - 1]
    if (!last || !this.grid) return null
    return this.grid.end(this.interval, this.grid.nextStart(this.interval, last.open))
  }

  get vendor(): string {
    return this.symbol.slice(0, this.symbol.indexOf(':'))
  }

  get ticker(): string {
    return this.symbol.slice(this.symbol.indexOf(':') + 1)
  }

  watch(listener: () => void, depth: number): void {
    const wasEmpty = this.listeners.size === 0
    this.listeners.add(listener)
    if (wasEmpty) this.owner.stream.subscribe(this.vendor, this.ticker, this.interval, this.listener)
    if (depth > this.depth) {
      this.depth = depth
      void this.load()
    }
  }

  /** True when nothing watches it any more (the caller drops it). */
  unwatch(listener: () => void): boolean {
    this.listeners.delete(listener)
    if (this.listeners.size > 0) return false
    this.owner.stream.unsubscribe(this.vendor, this.ticker, this.interval, this.listener)
    return true
  }

  /** The history: `depth` bars back from now, merged under whatever the stream has delivered
   * meanwhile. */
  private load(): Promise<void> {
    const run = async (): Promise<void> => {
      const now = this.owner.now()
      const length = resolutionDurationMs(this.interval)
      const depth = this.depth
      try {
        this.grid ??= await this.owner.data.grid(this.symbol)
        if (!this.grid) {
          // No market hours: no bar here has a close, so nothing can be evaluated. Ready, empty.
          console.warn(`[alerts] no market hours for ${this.symbol}: its alerts cannot be evaluated`)
          this.loaded = Math.max(this.loaded, depth)
          this.changed()
          return
        }
        const grid = this.grid
        this.mergeBars(this.early.map((b) => toReplayBar(this.interval, b as OHLCVBar & Record<string, unknown>, grid)))
        this.early = []
        const bars = await this.owner.data.bars(this.symbol, this.interval, now - 2 * depth * length - HISTORY_PAD_MS, now + length)
        // Only CLOSED bars: a history read ends with the forming one.
        this.mergeBars(bars.filter((b) => b.end <= this.owner.now()))
      } catch (err) {
        console.warn(`[alerts] no history for ${this.symbol} ${this.interval}`, err)
      }
      // Covered, or as covered as it will get: a failed read must not stall its alerts forever.
      this.loaded = Math.max(this.loaded, depth)
      this.changed()
    }
    this.loading = (this.loading ?? Promise.resolve()).then(run)
    return this.loading
  }

  private merge(bars: OHLCVBar[]): void {
    const grid = this.grid
    if (!grid) {
      this.early.push(...bars)
      return
    }
    this.mergeBars(bars.map((b) => toReplayBar(this.interval, b as OHLCVBar & Record<string, unknown>, grid)))
    this.changed()
  }

  private mergeBars(bars: AlertBar[]): void {
    if (bars.length === 0) return
    const byOpen = new Map(this.bars.map((b) => [b.open, b]))
    for (const bar of bars) byOpen.set(bar.open, bar)
    const sorted = [...byOpen.values()].sort((a, b) => a.open - b.open)
    this.bars = sorted.slice(-(this.depth + FEED_TAIL_BARS))
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** One plugin's points on one instrument and timeframe, read on demand. */
class PointFeed {
  /** Rows by date: a folded source (krev01) has several on one bar. */
  private readonly rows = new Map<number, Point[]>()
  private reading: Promise<void> | null = null
  users = 0

  constructor(
    readonly key: string,
    private readonly read: (from: number, to: number) => Promise<Point[]>
  ) {}

  /** Re-read `[from, to)`: what the server holds there now replaces what was held. */
  refresh(from: number, to: number): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        const fresh = await this.read(from, to)
        for (const date of [...this.rows.keys()]) if (date >= from && date < to) this.rows.delete(date)
        for (const point of fresh) {
          const list = this.rows.get(point.date)
          if (list) list.push(point)
          else this.rows.set(point.date, [point])
        }
      } catch (err) {
        console.warn(`[alerts] could not read ${this.key}`, err)
      }
    }
    this.reading = (this.reading ?? Promise.resolve()).then(run)
    return this.reading
  }

  /** The newest date held, or null. */
  newest(): number | null {
    let out: number | null = null
    for (const date of this.rows.keys()) if (out === null || date > out) out = date
    return out
  }

  /** Every row, ascending by date. */
  list(): Point[] {
    return [...this.rows.entries()].sort(([a], [b]) => a - b).flatMap(([, rows]) => rows)
  }
}

/** One alert, running. */
class Runner {
  readonly key: string
  private readonly compiled: CompiledRule
  private readonly feeds = new Map<string, Feed>()
  /** The lead-in this alert needs on each feed. */
  private readonly depths = new Map<string, number>()
  private readonly pointKeys = new Map<string, string>()
  /** How far each server operand's source has served, as of the last read: a missing value on a
   * bar at or before it is final, after it not written yet. */
  private served = new Map<string, number | null>()
  private watermark: number | null = null
  private state: RunState = freshRun()
  private timer: ReturnType<typeof setTimeout> | null = null
  private busy = false
  /** A change arrived while an evaluation was running: evaluate again when it ends. */
  private dirty = false
  private disposed = false
  private readonly onChange = (): void => this.schedule(this.owner.settleMs)

  constructor(
    readonly alert: Alert,
    private readonly owner: AlertMonitor
  ) {
    this.key = runnerKey(alert)
    this.compiled = compile(alert.rule)
    const operands = [...this.compiled.operands.values()]
    for (const interval of byInterval(operands).keys()) {
      const feed = owner.feed(alert.symbol, interval)
      const depth = leadInFor(operands, interval)
      this.feeds.set(interval, feed)
      this.depths.set(interval, depth)
      feed.watch(this.onChange, depth)
    }
    // A feed another alert already loaded says nothing new until its next bar: look now.
    this.schedule(0)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    for (const feed of this.feeds.values()) this.owner.release(feed, this.onChange)
    for (const key of this.pointKeys.values()) this.owner.releasePoints(key)
  }

  private schedule(ms: number): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.evaluate()
    }, ms)
  }

  /** Bring the alert up to date: every instant past the watermark, in order. */
  async evaluate(): Promise<void> {
    if (this.disposed) return
    if (this.busy) {
      this.dirty = true
      return
    }
    if ([...this.feeds].some(([interval, feed]) => !feed.readyFor(this.depths.get(interval) ?? 0))) return
    this.busy = true
    try {
      const tracks = await this.tracks()
      // Switched off, edited or deleted while the server was being read: say nothing.
      if (this.disposed) return
      const timeline = instants(tracks, this.compiled.fields)
      if (timeline.length === 0) return
      if (this.watermark === null) {
        this.seed(timeline)
        return
      }
      const now = this.owner.now()
      for (const instant of timeline) {
        if (instant.at <= this.watermark) continue
        if (this.waiting(instant, tracks) && now - instant.at < this.owner.graceMs) {
          // Something this close needs has not arrived yet: look again later, bounded by the
          // grace (`MonitorOptions.graceMs`).
          this.schedule(this.owner.pollMs)
          return
        }
        this.watermark = instant.at
        if (stepInstant(this.compiled.condition, this.alert, this.state, instant)) this.fire(instant)
        if (this.disposed) return
      }
    } finally {
      this.busy = false
      if (this.dirty && !this.disposed) {
        this.dirty = false
        this.schedule(this.owner.settleMs)
      }
    }
  }

  /** The first evaluation: nothing already closed may fire. The last instant is where the
   * edge and the crossings start from -- the baseline, as arming a watch seeds one. */
  private seed(timeline: Instant[]): void {
    const last = timeline[timeline.length - 1]
    const before = timeline.length > 1 ? timeline[timeline.length - 2].observation : null
    this.state.previous = last.observation
    this.state.policy.wasTrue = evaluate(this.compiled.condition, last.observation, before) === true
    this.watermark = last.at
  }

  /** Whether this instant cannot be decided yet: a timeframe's bar due by then has not arrived
   * (its frame is a second or two behind another's), or a server value on a bar closing then has
   * not been written. Evaluating anyway would read the previous bar's value -- the stale read
   * the timeline exists to refuse. */
  private waiting(instant: Instant, tracks: Track[]): boolean {
    for (const feed of this.feeds.values()) {
      const due = feed.nextClose()
      if (due !== null && due <= instant.at) return true
    }
    for (const track of tracks) {
      const index = track.at.indexOf(instant.at)
      if (index < 0) continue
      const date = track.dates?.[index]
      for (const [key, values] of track.values) {
        const operand = this.compiled.operands.get(key)
        if ((operand?.kind !== 'series' && operand?.kind !== 'signal') || values[index] !== undefined) continue
        // Missing where the source has already served past this bar is final: it wrote nothing
        // here (krev writes only on a fresh extreme). Only a bar after that may still be written.
        const through = this.served.get(key) ?? null
        if (through === null || date === undefined || date > through) return true
      }
    }
    return false
  }

  private async tracks(): Promise<Track[]> {
    const operands = [...this.compiled.operands.values()]
    const catalogue = operands.some((o) => o.kind === 'series' || o.kind === 'signal') ? await this.owner.catalogue() : null
    const out: Track[] = []
    for (const [interval, group] of byInterval(operands)) {
      const bars = (this.feeds.get(interval) as Feed).bars
      const indexes = new Map<string, PointIndex>()
      if (catalogue && bars.length > 0) {
        for (const operand of group.values()) {
          const source = pointSource(operand, catalogue)
          if (!source) continue
          const feed = this.points(operand, source)
          // Everything from the newest date the feed already has a point for: the tail is
          // where a late write lands.
          const newest = feed.newest()
          await feed.refresh(newest === null ? bars[0].date : Math.max(bars[0].date, newest), bars[bars.length - 1].date + 1)
          if (this.disposed) return out
          const index = indexPoints(feed.list(), source.foldBy)
          indexes.set(operandKey(operand), index)
          this.served.set(operandKey(operand), index.through)
        }
      }
      out.push(await buildTrack(interval, bars, group.values(), (o) => indexes.get(operandKey(o))))
    }
    return out
  }

  private points(operand: Operand, source: PointSource): PointFeed {
    const key = `${source.plugin}|${source.variant}|${this.alert.symbol}|${operand.interval}`
    // Held once per runner, however many evaluations ask: `dispose` releases what it holds --
    // and a runner already disposed takes nothing it would never give back.
    const hold = !this.pointKeys.has(key) && !this.disposed
    if (hold) this.pointKeys.set(key, key)
    return this.owner.pointFeed(key, source, this.alert.symbol, operand.interval, hold)
  }

  private fire(instant: Instant): void {
    if (this.disposed) return
    const fired = this.owner.store.recordFiring(this.alert.id, instant.at)
    const alert = fired ?? this.alert
    this.owner.notify.notify({
      title: alert.name,
      body: [alert.symbol.split(':')[1] ?? alert.symbol, readings(this.compiled, instant, this.owner.labelCatalogue), alert.note]
        .filter(Boolean)
        .join(' · '),
      level: 'alert',
      source: 'alert',
      data: { alertId: alert.id, eventAt: instant.at }
    })
  }
}

/** `RSI(14) 1h 28.31, Close 1h 1.08321` -- what the rule read at the instant it fired. */
export function readings(compiled: CompiledRule, instant: Instant, catalogue: ServerCatalogue | null): string {
  const parts: string[] = []
  for (const [key, operand] of compiled.operands) {
    const sample = instant.observation[key]
    if (!sample) continue
    const value = typeof sample.value === 'number' ? String(Number(sample.value.toPrecision(6))) : sample.value || 'none'
    parts.push(`${labelOperand(operand, catalogue)} ${operand.interval} ${value}`)
  }
  return parts.join(', ')
}

/** What a runner is built from: replaced when any of it changes. */
function runnerKey(alert: Alert): string {
  return `${alert.id}|${alert.armedAt}|${signature(alert)}`
}

export class AlertMonitor {
  readonly store: ClientAlertStore
  readonly notify: NotificationSink
  readonly data: AlertData
  readonly stream: BarStream
  readonly settleMs: number
  readonly pollMs: number
  readonly graceMs: number
  labelCatalogue: ServerCatalogue | null = null
  private readonly runners = new Map<string, Runner>()
  private readonly feeds = new Map<string, Feed>()
  private readonly pointFeeds = new Map<string, PointFeed>()
  private unsubscribe: (() => void) | null = null
  private readonly catalogueLoader: () => Promise<ServerCatalogue>
  private readonly clock: () => number

  constructor(options: MonitorOptions) {
    this.store = options.store
    this.notify = options.notify
    this.data = options.data
    this.stream = options.stream
    this.catalogueLoader = options.catalogue
    this.clock = options.now ?? (() => Date.now())
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  }

  now(): number {
    return this.clock()
  }

  async catalogue(): Promise<ServerCatalogue> {
    this.labelCatalogue ??= await this.catalogueLoader()
    return this.labelCatalogue
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.store.subscribe(() => this.reconcile())
    this.reconcile()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    for (const runner of this.runners.values()) runner.dispose()
    this.runners.clear()
  }

  /** Alerts running now, by id: for the debug hook and the tests. */
  running(): string[] {
    return [...this.runners.keys()]
  }

  /** Run exactly the enabled, armed alerts -- each on its current definition. */
  reconcile(): void {
    const wanted = new Map(this.store.list().filter((a) => a.status === 'armed').map((a) => [a.id, a]))
    for (const [id, runner] of this.runners) {
      const alert = wanted.get(id)
      if (!alert || runnerKey(alert) !== runner.key) {
        runner.dispose()
        this.runners.delete(id)
      }
    }
    for (const [id, alert] of wanted) {
      if (this.runners.has(id)) continue
      try {
        this.runners.set(id, new Runner(alert, this))
      } catch (err) {
        console.warn(`[alerts] cannot run ${alert.name}`, err)
      }
    }
  }

  /** Evaluate every running alert now (the debug hook; the tests). */
  async flush(): Promise<void> {
    for (const runner of [...this.runners.values()]) await runner.evaluate()
  }

  feed(symbol: string, interval: string): Feed {
    const key = `${symbol}|${interval}`
    let feed = this.feeds.get(key)
    if (!feed) {
      feed = new Feed(symbol, interval, this)
      this.feeds.set(key, feed)
    }
    return feed
  }

  release(feed: Feed, listener: () => void): void {
    if (feed.unwatch(listener)) this.feeds.delete(`${feed.symbol}|${feed.interval}`)
  }

  pointFeed(key: string, source: PointSource, symbol: string, interval: string, hold: boolean): PointFeed {
    let feed = this.pointFeeds.get(key)
    if (!feed) {
      feed = new PointFeed(key, (from, to) => this.data.points(source, symbol, interval, from, to))
      this.pointFeeds.set(key, feed)
    }
    if (hold) feed.users += 1
    return feed
  }

  releasePoints(key: string): void {
    const feed = this.pointFeeds.get(key)
    if (!feed) return
    feed.users -= 1
    if (feed.users <= 0) this.pointFeeds.delete(key)
  }
}
