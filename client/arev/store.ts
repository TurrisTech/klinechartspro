import { WindowStore } from '../plugins/store'
import type { Range } from '../plugins/types'
import type { ArevPoint } from './api'

// THE store for an arev21-series key, and deliberately the only one.
//
// Two bindings read that key: the AREV sub-pane (`arev/plugin.ts`), and the AREV21 MTF
// overlay (`mtf/plugin.ts`), which reads the same generation at intervals that are not its
// chart's. Sharing is the point -- a 15m, a 3m and a 1h pane all overlaying 4h arev21 pay
// for one fetch, not three -- but `storeFor(key, create)` calls `create` only when the key
// is ABSENT, so the binding that arrives first decides the class and the second silently
// gets it. When the two disagreed about what a stored value is, that was a real bug and it
// went both ways:
//
//   * AREV first (a plain `WindowStore`, values = `ArevPoint`): the overlay's own row type
//     went through the identity index and OVERWROTE the points with rows carrying no `p`,
//     so the sub-pane drew a gap on exactly those bars -- and `grid()` did not exist on the
//     store the overlay then read back.
//   * MTF first (values folded out of its row type): the sub-pane's `ArevPoint`s did not
//     match that fold and were dropped. It only looked correct because the overlay happened
//     to fetch the same votes and file them properly.
//
// The fix is structural, not a check: both sources name `arevStore` as their `createStore`,
// so the class is the same whichever binds first, and both write the SAME row -- an
// `ArevPoint` per bar. The overlay's extra need, the source timeframe's bar grid, rides
// beside the points as an auxiliary array on the same window (`Page.arrays`, the mechanism
// mtf01 uses for its trades) instead of being smuggled in as a second kind of value.
//
// Two specs sharing a key must also agree on `resolution` -- both say the source interval --
// or a replay step would forget different amounts of the one store (`plugins/horizon.ts`).

/** The auxiliary array the overlay ships its bar grid in. */
export const GRID_ARRAY = 'grid'

export class ArevStore extends WindowStore<ArevPoint> {
  /** Source-bar wire dates, ascending and deduplicated -- the grid `shift.ts` walks to find
   * each vote's successor bar. Empty unless some binding on this key fetches it (the AREV
   * sub-pane has no use for it and does not). */
  private gridSet = new Set<number>()
  private gridSorted: number[] | null = null

  override ingest(points: ArevPoint[], window: Range, arrays?: Record<string, { date: number }[]>): void {
    const grid = arrays?.[GRID_ARRAY]
    if (grid?.length) {
      for (const row of grid) this.gridSet.add(row.date)
      // Invalidated rather than re-sorted here: a pan can land several windows before any
      // template asks to draw, and sorting once on demand beats sorting once per fetch.
      this.gridSorted = null
    }
    super.ingest(points, window)
  }

  /** The source bar grid, ascending. Sorted lazily -- see ingest. */
  grid(): number[] {
    if (this.gridSorted === null) this.gridSorted = [...this.gridSet].sort((a, b) => a - b)
    return this.gridSorted
  }

  /** The grid goes with the points: a replay step forgets everything the old clock made
   * incomplete, and one rule for both kinds beats two. */
  override forgetAfter(from: number): void {
    for (const date of [...this.gridSet]) if (date >= from) this.gridSet.delete(date)
    this.gridSorted = null
    super.forgetAfter(from)
  }
}

/** The one factory for an arev21-series key. A module-level function on purpose: every
 * source that names this key passes THIS reference, so there is one place to look to see
 * that they cannot diverge. */
export function arevStore(key: string): ArevStore {
  return new ArevStore(key)
}
