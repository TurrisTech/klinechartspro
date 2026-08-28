import type { AlertSide, PriceAlert } from './types'

// When a price alert fires. Pure, and the only place the rule is written.
//
// The test is DIRECTIONAL, not a band containment, and that is what makes it stateless: an
// alert records which side of the level the market was on when it was armed (`from`), so
// "the market reached the level" is a one-sided comparison against the newest observation —
// no per-alert memory of the previous price, and no way for a reading from before the alert
// existed to fire it.
//
//   armed from below   ->  fires once the market trades AT or ABOVE the level
//   armed from above   ->  fires once the market trades AT or BELOW the level
//
// A stale reading cannot fire an alert, and a move that happened before it was armed cannot
// either, because `from` is taken from the market price at that instant. What CAN be missed
// is a crossing that happened while no tab was open: this is a client-side monitor with no
// server-side counterpart, so an alert is evaluated only while the dashboard is running, and
// a round trip through the level and back while it was closed leaves no trace to find. That
// is a property of where the feature lives, not a bug in this file.

/** One reading of the market, from a bar frame off `client/stream.ts`.
 *
 * `low`/`high` are the bar's extremes and are supplied ONLY when the bar opened at or after
 * the alert was armed (`armedAt <= bar.date`) — see `observationFor`. Ticks between two
 * frames are invisible otherwise, and on a fast move that is exactly where the crossing is;
 * but a bar that was already forming when the alert was armed carries extremes from before
 * it existed, and using those would fire it on a move the user never asked about. */
export interface PriceObservation {
  /** The bar's close: the newest price, forming or final. */
  price: number
  low?: number
  high?: number
}

/** Which side of `level` a market at `price` is on. Equality reads as `below`, so an alert
 * armed exactly at the market fires on the first reading that does not fall away from it —
 * which is the honest answer to "tell me when it is at 1.1600" when it already is. */
export function sideOf(price: number, level: number): AlertSide {
  return price > level ? 'above' : 'below'
}

/** The extreme of `observation` in the direction an alert armed from `from` is watching. */
export function reach(observation: PriceObservation, from: AlertSide): number {
  return from === 'below'
    ? Math.max(observation.price, observation.high ?? Number.NEGATIVE_INFINITY)
    : Math.min(observation.price, observation.low ?? Number.POSITIVE_INFINITY)
}

/** Does this reading fire an armed alert? Says nothing about its status — the caller skips
 * anything already triggered. */
export function triggers(
  alert: Pick<PriceAlert, 'price' | 'from'>,
  observation: PriceObservation
): boolean {
  const extreme = reach(observation, alert.from)
  return alert.from === 'below' ? extreme >= alert.price : extreme <= alert.price
}

/** The reading a bar frame contributes to one alert. `barOpenedAt` is the bar's own
 * timestamp; the extremes are dropped for a bar that was already forming when the alert was
 * armed, which is the whole of the "no crossing from before I existed" guarantee. */
export function observationFor(
  alert: Pick<PriceAlert, 'armedAt'>,
  bar: { date: number; high: number; low: number; close: number }
): PriceObservation {
  if (bar.date >= alert.armedAt) return { price: bar.close, high: bar.high, low: bar.low }
  return { price: bar.close }
}
