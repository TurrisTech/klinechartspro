import type { NotificationSink } from '../notifications'
import { formatInstant } from '../trading/format'
import { type LocalWatchSource, type LocalWatchState, type WatchFiring, LocalWatchRegistry } from '../watch/local'
import type { Observation, Sample } from '../watch/evaluate'
import { WatchStore } from '../watch/store'
import { PRICE_SOURCE } from '../watch/types'
import type { SourceField } from '../watch/types'
import type { ReplayBar } from './cache'
import type { ReplayObserver } from './session'

// PRICE WATCHES ON A REPLAY WALL: the same lines, the same right-click, the same dialog and
// the same Notification Center as a live wall — over the replay's own market instead of the
// server's.
//
// A live watch is evaluated in `wdashboard-server`, which is what lets it fire with the tab
// closed. A replay has no such market: its clock is the cursor and its prices are stored
// bars. So a replay wall swaps the BACKEND under `client/watch` (a `LocalWatchRegistry`
// implementing the same `WatchApi`) and feeds it observations from the walk. Everything the
// user touches is unchanged, and neither half of `client/watch` had to learn what a replay
// is.
//
// **The observations come from the base bars the engine walks** — the same data, in the same
// order, at the same granularity the replay's fills are decided on. Not the pane's interval
// (three panes would give three different answers), not a refined sub-bar (whether an order
// happens to be resting must not change when a watch fires), and not the forming bar (which
// is rebuilt as the cursor moves). One consequence worth stating: a watch is answered at the
// base interval, so a base of 1h sees a 1h bar's range, and a 5s base sees a 5s one.

/** What the watches need from the session. Structural, so a test can hand in a stub and the
 * session does not have to exist to exercise any of this. */
export interface ReplayWatchHost {
  readonly cursor: number
  /** The last base bar that closed at or before `at`. */
  barAt(at: number): Promise<ReplayBar | null>
  /** Write the replay's state blob (the watches ride in it). */
  persist(): void
}

export interface ReplayWatchesOptions {
  /** The replay's instrument, `vendor:TICKER` — the only one it walks. */
  symbol: string
  notify: NotificationSink
}

/** `vendor:SYMBOL`, or a bare symbol taken as the replay's own vendor. Mirrors the server
 * source's normalisation closely enough that a watch created here and one created there
 * spell their target the same way. */
function normalise(target: string, fallbackVendor: string): string {
  const raw = target.trim()
  if (!raw) throw new Error('target is required')
  const [head, ...rest] = raw.split(':')
  const symbol = rest.length > 0 ? rest.join(':') : head
  const vendor = rest.length > 0 ? head : fallbackVendor
  if (!symbol) throw new Error(`not an instrument: '${target}'`)
  return `${vendor.toLowerCase()}:${symbol.toUpperCase()}`
}

function field(name: string, label: string, description = ''): SourceField {
  return { name, label, kind: 'number', unit: 'price', description, choices: [] }
}

/** A base bar as the `price` source's observation.
 *
 * The bands are the whole reason this works at a bar's granularity: a base bar is a coarse
 * sample of a continuous price, and `Sample`'s low/high are what let `>=` and a crossing see
 * the move that happened INSIDE it — a wick through the level counts, exactly as it does for
 * the server's `bar` source. Without them a level between two closes would be stepped over
 * in silence.
 *
 * `spread` carries no band on purpose: a band from `ask.high − bid.low` would claim a spread
 * that never occurred, since the two extremes need not be the same instant. */
export function observeBar(bar: ReplayBar): Observation {
  const bid = bar.bid ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  const ask = bar.ask ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  const mid = (a: number, b: number): number => (a + b) / 2
  const band = (value: number, low: number, high: number): Sample => ({ value, low, high })
  return {
    price: band(mid(bid.c, ask.c), mid(bid.l, ask.l), mid(bid.h, ask.h)),
    bid: band(bid.c, bid.l, bid.h),
    ask: band(ask.c, ask.l, ask.h),
    spread: { value: ask.c - bid.c }
  }
}

/** The replay's `price` source: the same id, target spelling and fields as the server's, so
 * a watch document created on a replay wall is one the server would also accept. What
 * differs is where the readings come from — a base bar rather than a tick. */
class ReplayPriceSource implements LocalWatchSource {
  readonly id = PRICE_SOURCE
  readonly title = 'Price'
  readonly description = 'The replay price, from each base-interval bar as the cursor walks it.'
  readonly targetHint: string
  private latest: Observation | null = null
  private host: ReplayWatchHost | null = null

  constructor(
    readonly symbol: string,
    readonly vendor: string
  ) {
    this.targetHint = symbol
  }

  attach(host: ReplayWatchHost): void {
    this.host = host
  }

  available(): boolean {
    return true
  }

  fields(): SourceField[] {
    return [
      field('price', 'Price', 'The mid of bid and ask, carrying the bar’s range.'),
      field('bid', 'Bid'),
      field('ask', 'Ask'),
      field('spread', 'Spread', 'ask − bid at the close.')
    ]
  }

  normaliseTarget(target: string): string {
    const normalised = normalise(target, this.vendor)
    if (normalised !== this.symbol) {
      // Refused rather than stored: a replay walks ONE instrument, and a watch on any other
      // would be a line that can never fire, with nothing on screen to say so.
      throw new Error(`this replay walks ${this.symbol} only`)
    }
    return normalised
  }

  observe(bar: ReplayBar): Observation {
    this.latest = observeBar(bar)
    return this.latest
  }

  /** The reading a crossing is armed against. The walk's latest bar when there has been one;
   * otherwise the base bar the cursor is standing on, fetched — a watch placed before the
   * first step still has a baseline, which is what stops it firing on that step. */
  async current(): Promise<Observation | null> {
    if (this.latest) return this.latest
    const bar = await this.host?.barAt(this.host.cursor)
    if (!bar) return null
    this.latest = observeBar(bar)
    return this.latest
  }

  /** After a seek or a restore the walk's reading is stale — the cursor moved without any
   * bar passing through here. Dropping it makes the next arm fetch the bar it is standing on.
   */
  forget(): void {
    this.latest = null
  }
}

export class ReplayWatches implements ReplayObserver {
  readonly store: WatchStore
  private readonly registry: LocalWatchRegistry
  private readonly source: ReplayPriceSource
  private host: ReplayWatchHost | null = null

  constructor(private readonly opts: ReplayWatchesOptions) {
    const vendor = opts.symbol.split(':')[0] || 'oanda'
    this.source = new ReplayPriceSource(opts.symbol, vendor)
    this.registry = new LocalWatchRegistry({
      sources: [this.source],
      onFire: (firing) => this.raise(firing),
      // A firing changes a watch without a call through `WatchApi`, so the store is told to
      // re-read — the one thing that turns a fired line grey, exactly as a live wall's
      // `notification` frame does.
      onChange: () => {
        void this.store.refresh()
        this.host?.persist()
      }
    })
    this.store = new WatchStore(this.registry)
  }

  /** Bind to the session. Separate from the constructor because the session needs this as
   * its observer, and the two cannot both be built first. */
  attach(host: ReplayWatchHost): void {
    this.host = host
    this.source.attach(host)
  }

  /** Build the view's cache. No feature gate and no network: the backend is right here. */
  load(): Promise<void> {
    return this.store.load()
  }

  // -- the observer seam ------------------------------------------------------------------

  /** An advance must walk base bars whenever a watch is armed, even with nothing resting and
   * nothing protected. Otherwise the account's "nothing can fill, so seek" shortcut would
   * step over the whole span a watch was placed to see. */
  needsBars(): boolean {
    return this.registry.armedTargets().length > 0
  }

  onBar(bar: ReplayBar): void {
    const observation = this.source.observe(bar)
    // The bar's CLOSE is the event instant: a watch answered by a bar is answered when that
    // bar is complete, and it is the clock the cooldown measures on. Never the wall clock —
    // a session replaying 2024 must have a 2024 cooldown.
    this.registry.onEvent(this.source.id, this.opts.symbol, bar.end, observation)
  }

  toState(): LocalWatchState[] {
    return this.registry.toState()
  }

  // -- lifecycle --------------------------------------------------------------------------

  restore(rows: readonly LocalWatchState[] | undefined): void {
    if (rows && rows.length > 0) this.registry.restore(rows)
    this.source.forget()
  }

  /** The cursor moved without a walk (a seek, or a restore): the last reading is not what
   * this instant looks like any more. */
  seeked(): void {
    this.source.forget()
  }

  /** Re-emit after an advance, so a line whose pane was reloaded at the new cursor is drawn
   * again against a timestamp the chart still knows. */
  refresh(): void {
    void this.store.refresh()
  }

  /** Why this instrument cannot be watched on this wall, or null when it can. The menu shows
   * it instead of offering rows that would create a watch nothing will ever evaluate. */
  canWatch(target: string): string | null {
    return target === this.opts.symbol ? null : `Replay walks ${this.opts.symbol.split(':').pop()} only`
  }

  private raise(firing: WatchFiring): void {
    this.opts.notify.notify({
      title: firing.title,
      // The replay instant is in the body, not in `at`: a notification is dated when it was
      // RAISED, on the wall clock the whole list sorts and ages by — dating this row 2024
      // would file it below everything else forever. The event instant rides in `data`, as
      // the server's does.
      body: `${firing.body} · replay ${formatInstant(firing.at)}`,
      level: 'alert',
      // `replay`, NOT `watch`. The centre is a page-level singleton, so this row outlives
      // the wall that raised it and is still in the bell after Exit -- which is right, it is
      // something that happened. But `source` is the row's visible tag and the key
      // `clear(source)` works on, so tagging it `watch` would make an alert about 2024 read
      // as one about the live market, and clearing one kind would clear the other.
      source: 'replay',
      data: {
        watchId: firing.watch.id,
        watchSource: firing.watch.source,
        target: firing.watch.target,
        condition: firing.watch.condition,
        values: Object.fromEntries(Object.entries(firing.observation).map(([k, s]) => [k, s.value])),
        eventAt: firing.at,
        replay: true
      }
    })
  }
}
