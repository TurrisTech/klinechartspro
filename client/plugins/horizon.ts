import { type CandleGrid, isInterval, nominalMs } from '../replay/timeframes'

// PURE. How far a source's answer is FINAL under a read clock.
//
// Every values route is clamped to the replay cursor (`services/asof.py`): a point exists
// once its bar has CLOSED, never at its label. So an answer fetched at cursor `C` is
// complete only up to the bar that was still forming at `C` -- and the store must record
// exactly that much coverage, or the forming bar's label stays filed as "fetched, no value"
// for the rest of the session and its point never arrives.
//
// That is the freshness-horizons trap in miniature (notes/architecture/freshness-horizons.md,
// "a boundary is when data CAN change, not when it HAS been written"): a window is covered
// up to when the answer stops depending on the clock, not up to what was asked for.

/** The first bar date `resolution` could still change at, under read clock `clock`: the
 * WIRE date of the bar that is forming at `clock`. Every earlier bar has closed, so every
 * earlier point is final; this one and everything after it is not.
 *
 * Stated on the wire clock because that is what a source's points and windows are keyed by
 * -- daily-and-coarser bars are dated by session (`services/wiredate.py`: open + 7h forex, the
 * open itself for crypto, open - 9h for equities), so the horizon of a forex `1D` source at
 * Wednesday noon is Wednesday's canonical date, not Tuesday 17:00.
 *
 * On `grid`, the schedule of the instrument the source's pane shows: a coinbase day forms from
 * UTC midnight, not from 17:00 New York, and reading it on the FX week would put the horizon
 * after the forming bar and leave that bar filed as fetched-and-empty.
 *
 * A source that declares no resolution (or one this client cannot parse) is given the clock
 * itself: nothing past the cursor was knowable, which is the weakest true statement and the
 * behaviour before any of this. A pane with no resolved schedule (`grid` null) is given a
 * horizon earlier than any schedule's could be -- two bars and a day back -- because forgetting
 * too much costs a refetch while forgetting too little costs a permanent hole.
 */
export function knownThrough(resolution: string | undefined, clock: number, grid: CandleGrid | null): number {
  if (!resolution || !isInterval(resolution)) return clock
  if (!grid) return clock - 2 * nominalMs(resolution) - DAY_MS
  return grid.toWire(resolution, grid.start(resolution, clock))
}

const DAY_MS = 86_400_000
