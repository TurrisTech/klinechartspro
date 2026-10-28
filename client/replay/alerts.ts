import type { ServerCatalogue } from '../alerts/catalogue'
import { readings } from '../alerts/monitor'
import { compile } from '../alerts/rules'
import { type AlertHit, type AlertSearch, earliestHit } from '../alerts/search'
import type { Alert } from '../alerts/types'
import type { AlertOccurrence } from './clock'

// NEXT ALERT: where the replay's next stop is, by the alert manager's rules.
//
// The alerts are the user's own client alerts (client/alerts) -- the same list a live wall
// watches, and the Alerts window shows -- every ENABLED one, on whatever instrument it watches
// (user, 2026-10-28: "next alert should be just the next alert according to the Alerts popup, not
// on current chart"). Each is searched on its own instrument's bars and schedule, and the replay's
// clock -- one clock for every pane -- is what stops there; which chart is showing, or which
// instrument the replay walks, plays no part. Until then only the walked instrument's alerts
// counted, so a wall replaying EURGBP had no Next alert for an alert on EURUSD. Whether one has
// fired on the live market (`once`) is about the live market and is ignored here: a replay asks
// where the rule next triggers in ITS history (client/alerts/timeline.ts `scan`).
//
// The search reads past the replay's clock (client/alerts/data.ts): it is the replay's own
// look-ahead, hidden from the chart until the cursor gets there, exactly like its bar caches.

export interface SearchProgress {
  /** Asked between chunks of the search: true stops it (a Stop press). */
  shouldStop(): boolean
  /** How far the search has looked. */
  onProgress(reached: number): void
}

/** What the session asks. Structural, so a test hands in a stub. */
export interface ReplayAlertBook {
  /** The alerts Next alert can stop at. */
  count(): number
  /** The first alert triggering in `(after, until]`, or null. */
  next(after: number, until: number, progress: SearchProgress): Promise<AlertOccurrence | null>
  /** Start looking for the first alert after `after` now, so that a Next alert pressed later
   * finds the answer waiting. Optional: a book without it searches when asked. Resolves to the
   * instant that search found, or null (nothing, stopped, superseded or failed) -- for reading
   * ahead what a press would land on. */
  prefetch?(after: number, until: number): Promise<number | null>
  /** Abandon any search in the background (the replay was left). */
  dispose?(): void
}

/** How many alerts ahead of the cursor the look-ahead keeps found: a press takes the first, and
 * the chain is topped up behind it while the user reads the chart. */
export const ALERTS_AHEAD = 5

/** The look-ahead: the triggers after `from`, found one search at a time, each from the last. */
interface Chain {
  /** Which alerts it searched: a list edited since makes it stale. */
  signature: string
  /** Where its first search started, and its `until`. */
  from: number
  until: number
  /** Every trigger in `(from, through]`, ascending: each the first after the one before it. */
  hits: AlertHit[]
  through: number
  /** A search from `through` found nothing up to `until`: there is nothing more to find. */
  exhausted: boolean
  /** The search running from `through`, if one is. */
  step: Step | null
  /** Superseded, or stopped while awaited: either way nothing more is taken from it. */
  dropped: boolean
}

interface Step {
  promise: Promise<void>
  /** Who is waiting for it now: their Stop stops it, and they see its progress. */
  waiter: SearchProgress | null
  reached: number | null
}

export class ReplayAlerts implements ReplayAlertBook {
  // THE LOOK-AHEAD. A search is pure look-ahead: what it answers from `after` depends only on
  // the alerts and on history, never on the cursor. And its answer from `after` -- the first
  // trigger, H, in `(after, until]` -- is also the answer from any later instant before H: no
  // alert triggers in between, and whether one triggers at an instant (an edge, a crossing) is
  // decided by the instants before it, which are the same whatever the search started from
  // (client/alerts/search.ts seeds from the bar closes before `after`). So the search from H
  // finds the trigger after it, and so on: a chain of searches holds every trigger from where it
  // started to its last hit, and answers a press from any cursor inside that span at once.
  //
  // It is kept ALERTS_AHEAD triggers ahead of the cursor (user, 2026-10-28: "alerts should be
  // cached into the future as well"): after every advance the session asks for the next one
  // (`prefetch`), and the chain is topped up behind it while the chart loads and the user reads
  // it. A Step that stays inside the chain keeps it; one past its end, or an edit of the alerts,
  // starts another from the cursor.
  //
  // One search at a time: they share the alert search's caches, which read for one caller.
  private chain: Chain | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    /** The enabled alerts, on every instrument. */
    private readonly alerts: () => Alert[],
    private readonly search: AlertSearch,
    /** For the readings' labels only. */
    private readonly catalogue: () => Promise<ServerCatalogue | null> = async () => null
  ) {}

  count(): number {
    return this.alerts().length
  }

  prefetch(after: number, until: number): Promise<number | null> {
    const signature = this.signature()
    if (this.count() === 0) return Promise.resolve(null)
    const chain = this.usable(this.chain, signature, after, until) ? (this.chain as Chain) : this.start(signature, after, until)
    void this.topUp(chain, after)
    return this.first(chain, after, null).then((hit) => hit?.at ?? null)
  }

  dispose(): void {
    if (this.chain) this.chain.dropped = true
    this.chain = null
  }

  async next(after: number, until: number, progress: SearchProgress): Promise<AlertOccurrence | null> {
    const signature = this.signature()
    const chain = this.usable(this.chain, signature, after, until) ? (this.chain as Chain) : this.start(signature, after, until)
    const hit = await this.first(chain, after, progress)
    return hit ? this.occurrence(hit) : null
  }

  /** The first trigger after `after` the chain holds or finds -- waiting on its searches, which a
   * waiter's Stop stops -- or null: none before `until`, or the chain was dropped. */
  private async first(start: Chain, after: number, waiter: SearchProgress | null): Promise<AlertHit | null> {
    let chain = start
    for (;;) {
      const held = chain.hits.find((h) => h.at > after)
      if (held) return held
      if (chain.dropped || chain.exhausted) return null
      // Past everything the chain has searched, with nothing running: a chain from the cursor
      // finds the next trigger sooner than one searching on through the gap.
      if (after > chain.through && chain.step === null) chain = this.start(chain.signature, after, chain.until)
      await this.extend(chain, waiter)
    }
  }

  /** Search on from the chain's end until ALERTS_AHEAD triggers lie after `after`, in the background. */
  private async topUp(chain: Chain, after: number): Promise<void> {
    while (!chain.dropped && !chain.exhausted && chain.hits.filter((h) => h.at > after).length < ALERTS_AHEAD) {
      await this.extend(chain, null)
    }
  }

  /** One search from the chain's end -- or the one already running, joined -- and what it found
   * added to the chain. */
  private extend(chain: Chain, waiter: SearchProgress | null): Promise<void> {
    let step = chain.step
    if (!step) {
      const from = chain.through
      const alerts = this.alerts()
      const running: Step = { promise: Promise.resolve(), waiter: null, reached: null }
      let stopped = false
      const search = this.tail.then(() =>
        chain.dropped
          ? null
          : earliestHit(this.search, alerts, from, chain.until, {
              shouldStop: () => {
                if (!stopped && running.waiter?.shouldStop()) stopped = true
                return stopped || chain.dropped
              },
              onProgress: (reached) => {
                running.reached = reached
                running.waiter?.onProgress(reached)
              }
            })
      )
      running.promise = search.then(
        (hit) => {
          chain.step = null
          // Stopped (a waiter's Stop) or superseded: its null means nothing, and nothing is kept.
          if (stopped || chain.dropped) {
            chain.dropped = true
            if (this.chain === chain) this.chain = null
            return
          }
          if (hit === null) {
            chain.exhausted = true
            chain.through = chain.until
          } else {
            chain.hits.push(hit)
            chain.through = hit.at
          }
        },
        (err) => {
          // A failed search is not an answer: drop the chain, and the press that wanted it says why.
          chain.step = null
          chain.dropped = true
          if (this.chain === chain) this.chain = null
          console.error('[replay] the alert search failed', err)
        }
      )
      this.tail = running.promise
      chain.step = running
      step = running
    }
    if (waiter) {
      step.waiter = waiter
      if (step.reached !== null) waiter.onProgress(step.reached)
    }
    return step.promise.finally(() => {
      if (waiter && step.waiter === waiter) step.waiter = null
    })
  }

  /** Whether `chain` answers a search from `after`: same alerts, same end, started at or before
   * `after`, and `after` no further than it has searched or a search of it still running (whose
   * answer may well lie past `after`) -- past that, a chain from the cursor finds the next trigger
   * sooner than one searching on through the gap. */
  private usable(chain: Chain | null, signature: string, after: number, until: number): boolean {
    if (!chain || chain.dropped || chain.signature !== signature || chain.until !== until || chain.from > after) return false
    return after <= chain.through || chain.exhausted || chain.step !== null
  }

  private start(signature: string, after: number, until: number): Chain {
    if (this.chain) this.chain.dropped = true
    const chain: Chain = { signature, from: after, until, hits: [], through: after, exhausted: false, step: null, dropped: false }
    this.chain = chain
    return chain
  }

  private async occurrence(hit: AlertHit): Promise<AlertOccurrence> {
    return {
      alertId: hit.alert.id,
      name: hit.alert.name,
      symbol: hit.alert.symbol,
      effective: hit.at,
      readings: readings(compile(hit.alert.rule), hit.instant, await this.catalogue().catch(() => null))
    }
  }

  /** The alerts as searched: an edit of a rule or a trigger, or one switched on or off, changes
   * it. Nothing else does -- a name, a note, a firing on the live market change no answer. */
  private signature(): string {
    return JSON.stringify(this.alerts().map((a) => [a.id, a.symbol, a.rule, a.trigger]))
  }
}
