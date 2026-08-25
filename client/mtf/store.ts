import type { ArevPoint } from '../arev/api'
import { WindowStore } from '../plugins/store'
import type { Range } from '../plugins/types'

// What the client holds for one (instrument, SOURCE timeframe) pair. A WindowStore of
// arev21 votes with one addition that comes from this being a multi-timeframe overlay:
// it holds the source timeframe's BAR GRID beside the votes, because placing a vote one
// bar forward needs the grid (see shift.ts) and the two are fetched together over the
// same window, so one set of ranges covers both.
//
// Keyed by the source timeframe, NOT the chart's: two panes showing 1h and 4h charts with
// the 1D overlay ticked share one store, because what they are both reading is the 1D
// votes -- the chart's own interval only enters at drawing time. Windows are tracked in
// the SOURCE interval's own wire dates, a constant offset from absolute time for a fixed
// interval (shift.ts), so they order and merge identically.

export type MtfItem = { kind: 'vote'; date: number; point: ArevPoint } | { kind: 'bar'; date: number }

export class MtfStore extends WindowStore<MtfItem, ArevPoint> {
  /** Source-bar wire dates, ascending and deduplicated -- the grid shift.ts walks. */
  private gridSet = new Set<number>()
  private gridSorted: number[] | null = null

  constructor(key: string) {
    super(key, (item, existing) => (item.kind === 'vote' ? item.point : (existing as ArevPoint)))
  }

  override ingest(items: MtfItem[], window: Range): void {
    const votes: MtfItem[] = []
    let gridChanged = false
    for (const item of items) {
      if (item.kind === 'bar') {
        this.gridSet.add(item.date)
        gridChanged = true
      } else votes.push(item)
    }
    // Invalidated rather than re-sorted here: a pan can land several windows before any
    // template asks to draw, and sorting once on demand beats sorting once per fetch.
    if (gridChanged) this.gridSorted = null
    super.ingest(votes, window)
  }

  /** The source bar grid, ascending. Sorted lazily -- see ingest. */
  grid(): number[] {
    if (this.gridSorted === null) this.gridSorted = [...this.gridSet].sort((a, b) => a - b)
    return this.gridSorted
  }
}
