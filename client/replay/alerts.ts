import type { ServerCatalogue } from '../alerts/catalogue'
import { readings } from '../alerts/monitor'
import { compile } from '../alerts/rules'
import { type AlertSearch, earliestHit } from '../alerts/search'
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
}

export class ReplayAlerts implements ReplayAlertBook {
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

  async next(after: number, until: number, progress: SearchProgress): Promise<AlertOccurrence | null> {
    const hit = await earliestHit(this.search, this.alerts(this.symbol), after, until, {
      shouldStop: () => progress.shouldStop(),
      onProgress: (reached) => progress.onProgress(reached)
    })
    if (!hit) return null
    return {
      alertId: hit.alert.id,
      name: hit.alert.name,
      effective: hit.at,
      readings: readings(compile(hit.alert.rule), hit.instant, await this.catalogue().catch(() => null))
    }
  }
}
