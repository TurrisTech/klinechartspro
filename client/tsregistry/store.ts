import { WindowStore } from '../plugins/store'
import type { Range } from '../plugins/types'

// THE store class for every registry-driven source, and deliberately the only one.
//
// `storeFor(key, create)` calls `create` only when the key is ABSENT, so the binding that
// arrives first decides the class and every later one silently gets it. Two bindings really
// do share a key here: the AREV21 sub-pane and the AREV21 multi-timeframe overlay
// (`client/mtf/`), which reads the same generation at intervals that are not its chart's.
// When the two disagreed about what a stored value is, that was a real bug and it went both
// ways -- the overlay's rows overwrote the pane's votes with rows carrying no `p`, and the
// overlay then read back a store with no `grid()`: 0 of 266 votes and 0 markers on a 1h
// pane carrying both.
//
// The fix is structural rather than a check. There is one class; it always carries the
// auxiliary bar grid, whether or not any binding on the key fetches one; and `storeFactory`
// MEMOISES by fold, so two sources that agree about folding pass the identical function
// reference and cannot diverge.
//
// Two specs sharing a key must also agree on `resolution` -- both say the source interval --
// or a replay step would forget different amounts of the one store (`plugins/horizon.ts`).

/** The auxiliary array a source ships a bar grid in (the MTF overlay's, for placing a vote
 * one source bar forward). */
export const GRID_ARRAY = 'grid'

/** A served point, by the only property every one of them has. Deliberately NOT an index
 * signature: a row's fields are the registry's business, read through `readField`, and an
 * index signature here would make every other point type in the app (`ArevPoint`,
 * `IndicatorPoint`) incompatible with this one in both directions. */
export interface RegistryPoint {
  date: number
}

/** What one bar holds. Unfolded, that is the point itself; folded, an object keyed by the
 * fold field's value -- `{ top: <point>, bottom: <point> }` for krev01, which is what makes
 * a two-part series key (`top.p`) resolve with a plain field read. */
export type BarValue = RegistryPoint | Record<string, RegistryPoint>

/** `V` is what a bar holds, and a reader that knows the row shape says so:
 * `peekStore<RegistryStore<ArevPoint>>(key)`. It never changes the class -- every
 * registry-driven source shares one -- only what the reader has to narrow. */
export class RegistryStore<V = BarValue> extends WindowStore<RegistryPoint, V> {
  private gridSet = new Set<number>()
  private gridSorted: number[] | null = null

  override ingest(points: RegistryPoint[], window: Range, arrays?: Record<string, { date: number }[]>): void {
    const grid = arrays?.[GRID_ARRAY]
    if (grid?.length) {
      for (const row of grid) this.gridSet.add(row.date)
      // Invalidated rather than re-sorted here: a pan can land several windows before any
      // template asks to draw, and sorting once on demand beats sorting once per fetch.
      this.gridSorted = null
    }
    super.ingest(points, window)
  }

  /** The source bar grid, ascending. Empty unless some binding on this key fetches one. */
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

const factories = new Map<string, (key: string) => RegistryStore>()

/** The one factory for a given fold. Memoised on purpose: every source that names a key
 * passes the SAME function reference, so there is one place to look to see that two
 * bindings on one key cannot diverge. */
export function storeFactory(foldBy: string | null | undefined): (key: string) => RegistryStore {
  const cacheKey = foldBy ?? ''
  const existing = factories.get(cacheKey)
  if (existing) return existing
  const index = foldBy
    ? (point: RegistryPoint, prior: BarValue | undefined) => {
        const side = (point as unknown as Record<string, unknown>)[foldBy]
        // A row whose fold field is missing or not a string cannot be filed under a side;
        // keeping whatever is already there beats overwriting a good fold with a bad row.
        if (typeof side !== 'string') return (prior ?? point) as BarValue
        return { ...((prior ?? {}) as Record<string, RegistryPoint>), [side]: point }
      }
    : (point: RegistryPoint) => point as BarValue
  const factory = (key: string) => {
    const store = new RegistryStore(key, index)
    return store
  }
  factories.set(cacheKey, factory)
  return factory
}

/** Store identity for one indicator on one instrument and interval. Everything that decides
 * the data, and nothing else. The format is the one the AREV sources have always used, so a
 * registry-driven arev21 source and the MTF overlay's land on the same store. */
export function registrySourceKey(name: string, vendor: string, ticker: string, interval: string): string {
  return `${name}|${vendor}:${ticker}|${interval}`
}
