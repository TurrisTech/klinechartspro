import { intervalStart, MARKET_TZ } from './timeframes'

// PURE. Picking a random start instant for a replay, out of a range of past dates.
//
// A draw is uniform over the range and snapped DOWN to a `base` candle open -- the same floor
// `index.ts` applies to a typed date. Nothing else: the closed window is not excluded and the
// store is not probed. A start inside the weekend is a start on the candle that most recently
// opened, which is what the wall draws anyway, and a start the store has no bars for draws an
// empty wall you can Random away from.

export interface StartRange {
  /** Inclusive bounds, as instants. */
  from: number
  to: number
}

/** How far back the range starts by default: enough history that two picks are rarely the
 * same week, short enough that the store plausibly covers it. */
export const DEFAULT_RANGE_MS = 2 * 365 * 86_400_000

/** The range Random draws from when no explicit one is given. The upper bound is pulled back
 * a day so a pick always has a session ahead of it to replay. */
export function defaultRange(latest: number): StartRange {
  return { from: latest - DEFAULT_RANGE_MS, to: latest - 86_400_000 }
}

/** A uniform instant in `range`, snapped down to a `base` candle open. The snap is a floor, so
 * the result can sit up to one candle before `range.from` -- harmless, and cheaper than the
 * arithmetic to avoid it. `rng` is injected for the tests; it must return [0, 1). */
export function randomStart(range: StartRange, base: string, rng: () => number = Math.random, tz: string = MARKET_TZ): number {
  const span = Math.max(0, range.to - range.from)
  return intervalStart(base, range.from + Math.floor(rng() * span), tz)
}
