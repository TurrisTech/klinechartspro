import type { ServerCatalogue } from '../alerts/catalogue'
import { readings } from '../alerts/monitor'
import { compile } from '../alerts/rules'
import { type AlertHit, type AlertSearch, earliestHit } from '../alerts/search'
import type { Alert } from '../alerts/types'
import type { AlertOccurrence } from './clock'

// NEXT ALERT: where the replay's next stop is, by the alert manager's rules.
//
// The alerts are the user's own client alerts (client/alerts) -- the same list a live wall
// watches -- on the instrument this replay walks, and only the ENABLED ones. Whether one has
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

/** One search, running or done, and what it is good for. */
interface Lookahead {
  /** Which alerts it searched: a list edited since makes it stale. */
  signature: string
  /** The `after` it searched from, and its `until`. */
  from: number
  until: number
  promise: Promise<AlertHit | null>
  done: boolean
  hit: AlertHit | null
  /** Superseded (another search replaced it) or stopped (a Stop press while it was awaited):
   * either way its null means nothing and its answer is not reused. */
  dropped: boolean
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
  // (client/alerts/search.ts seeds from the bar closes before `after`). So the session asks
  // for the next one as soon as an advance lands, the search runs while the chart loads and
  // the user reads it, and the next press of Next alert usually finds the answer waiting. A
  // Step that stays short of H keeps it valid; one past it, or an edit of the alerts, starts
  // another.
  //
  // One search at a time: they share the alert search's caches, which read for one caller.
  private ahead: Lookahead | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly symbol: string,
    private readonly alerts: (symbol: string) => Alert[],
    private readonly search: AlertSearch,
    /** For the readings' labels only. */
    private readonly catalogue: () => Promise<ServerCatalogue | null> = async () => null
  ) {}

  count(): number {
    return this.alerts(this.symbol).length
  }

  prefetch(after: number, until: number): Promise<number | null> {
    const signature = this.signature()
    if (this.count() === 0) return Promise.resolve(null)
    const ahead = this.usable(this.ahead, signature, after, until) ? (this.ahead as Lookahead) : this.start(signature, after, until)
    return ahead.promise.then((hit) => (ahead.dropped || hit === null || hit.at <= after ? null : hit.at))
  }

  dispose(): void {
    if (this.ahead) this.ahead.dropped = true
    this.ahead = null
  }

  async next(after: number, until: number, progress: SearchProgress): Promise<AlertOccurrence | null> {
    const signature = this.signature()
    // Twice at most: a look-ahead started before a Step moved the cursor past what it then
    // found is good for nothing here, and is replaced by a search from the cursor.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ahead = this.usable(this.ahead, signature, after, until) ? (this.ahead as Lookahead) : this.start(signature, after, until)
      ahead.waiter = progress
      if (ahead.reached !== null) progress.onProgress(ahead.reached)
      let hit: AlertHit | null
      try {
        hit = await ahead.promise
      } finally {
        ahead.waiter = null
      }
      if (ahead.dropped) {
        // Stopped by this caller's Stop (or the replay was left): nothing found, nothing kept.
        if (this.ahead === ahead) this.ahead = null
        return null
      }
      if (hit === null) return null
      if (hit.at > after) return this.occurrence(hit)
    }
    return null
  }

  /** Whether `ahead` answers a search from `after`: same alerts, same end, started at or before
   * `after`, and -- once done -- not found at or before it. */
  private usable(ahead: Lookahead | null, signature: string, after: number, until: number): boolean {
    if (!ahead || ahead.dropped || ahead.signature !== signature || ahead.until !== until || ahead.from > after) return false
    return !ahead.done || ahead.hit === null || ahead.hit.at > after
  }

  private start(signature: string, after: number, until: number): Lookahead {
    if (this.ahead) this.ahead.dropped = true
    const alerts = this.alerts(this.symbol)
    const ahead: Lookahead = {
      signature,
      from: after,
      until,
      promise: Promise.resolve(null),
      done: false,
      hit: null,
      dropped: false,
      waiter: null,
      reached: null
    }
    const run = this.tail.then(() =>
      ahead.dropped
        ? null
        : earliestHit(this.search, alerts, after, until, {
            shouldStop: () => {
              if (!ahead.dropped && ahead.waiter?.shouldStop()) ahead.dropped = true
              return ahead.dropped
            },
            onProgress: (reached) => {
              ahead.reached = reached
              ahead.waiter?.onProgress(reached)
            }
          })
    )
    ahead.promise = run.then(
      (hit) => {
        ahead.done = true
        ahead.hit = hit
        return hit
      },
      (err) => {
        // A failed look-ahead is not an answer: drop it, and the press that wanted it says why.
        ahead.done = true
        ahead.dropped = true
        console.error('[replay] the alert search failed', err)
        return null
      }
    )
    this.tail = ahead.promise
    this.ahead = ahead
    return ahead
  }

  private async occurrence(hit: AlertHit): Promise<AlertOccurrence> {
    return {
      alertId: hit.alert.id,
      name: hit.alert.name,
      effective: hit.at,
      readings: readings(compile(hit.alert.rule), hit.instant, await this.catalogue().catch(() => null))
    }
  }

  /** The alerts as searched: an edit of a rule or a trigger, or one switched on or off, changes
   * it. Nothing else does -- a name, a note, a firing on the live market change no answer. */
  private signature(): string {
    return JSON.stringify(this.alerts(this.symbol).map((a) => [a.id, a.rule, a.trigger]))
  }
}
