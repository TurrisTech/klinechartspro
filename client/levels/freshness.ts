import { fromWireDate, intervalEnd, intervalStart, nextSessionAnchor } from '../replay/timeframes'

// PURE. When to look at a level book again.
//
// **17:00 is when a candle closes, not when its levels exist.** Between the two the bar has
// to be downloaded by the OANDA feed, stored, published on `ohlcv.bar.*`, consumed by the
// indicator feed, written to `indicators.level` and its watermark advanced. A horizon that
// is purely calendar-derived — "levels change at 17:00, so ask again at 17:00" — lands
// inside that gap, is handed the PREVIOUS book, and then sets its next horizon a full day
// out. Weekly closes survive that (Friday 17:00 is inside the market-closed window and the
// Saturday tick collects the new book before Sunday's open); a monthly close on a Monday to
// Thursday does not, and would show last month's levels through the following session.
//
// So the horizon is derived from what the server says it has actually computed
// (`X-Levels-Computed-Through`, one watermark per interval) and not from the calendar alone.
//
// The hard part is not the late case, it is the **never** case. A bar that is not written
// today is indistinguishable, at the moment of asking, from one that is thirty seconds away:
// the feed pod may be down, the month's data may not be backfilled (dev's 1M books for 27
// symbols are nearly empty by design), the instrument may have stopped trading. "Poll until
// the watermark moves" never terminates for any of those. So being behind only earns a short
// horizon for a bounded window after the close; past that the book is taken to be as good as
// it is going to get and the calendar horizon returns.

/** Per interval code, the last bar the indicator feed has consumed, on the **wire's** bar
 * clock (`X-Levels-Computed-Through`). An absent code means the series is not declared —
 * nothing will ever arrive for it. `0` means declared but nothing consumed yet, which is a
 * backfill in progress and is worth waiting for. */
export type Watermark = Readonly<Record<string, number>>

/** How long after a close a behind watermark still counts as "coming". Generous, because the
 * cost of being wrong in each direction is not symmetric: waiting a little longer costs one
 * conditional request that answers 304 in about four milliseconds and no body, while giving
 * up early costs a chart showing the previous month's levels for a whole session. */
export const SETTLE_WINDOW_MS = 6 * 3_600_000

/** Floor and ceiling on the recheck delay while a watermark is behind. The floor keeps the
 * first minute from becoming a poll loop; the ceiling keeps a long outage at two cheap
 * revalidations an hour rather than one a day. */
export const MIN_RECHECK_MS = 30_000
export const MAX_RECHECK_MS = 30 * 60_000

/** The most recent close of `code` at or before `at`.
 *
 * `intervalEnd` gives the close of the candle `at` sits in, which is normally in the future;
 * the one before it is then the close of the candle before. Written so that `at` landing
 * exactly ON a close returns that close and not the previous one — that instant is precisely
 * when a client refreshes, and being off by one there would report a feed as caught up at the
 * only moment it cannot be. */
export function lastClose(code: string, at: number): number {
  const close = intervalEnd(code, at)
  if (close <= at) return close
  return intervalEnd(code, intervalStart(code, at) - 1)
}

/** How long to wait before asking again, given how long the close has already gone
 * unanswered. Proportional, so a feed that is seconds late is caught in seconds and one that
 * is hours late is not asked about every thirty seconds for hours. */
export function recheckDelay(lateBy: number): number {
  return Math.min(MAX_RECHECK_MS, Math.max(MIN_RECHECK_MS, Math.floor(lateBy / 2)))
}

/** Whether `code`'s watermark covers every bar of `code` that had closed by `at`. */
export function caughtUp(code: string, throughWire: number, at: number): boolean {
  // <= 0 is the "declared, nothing consumed yet" sentinel; there is no bar to take the
  // close of, and doing the interval arithmetic on the epoch would be meaningless.
  if (throughWire <= 0) return false
  return intervalEnd(code, fromWireDate(code, throughWire)) >= lastClose(code, at)
}

/**
 * When a book fetched at `fetchedAt` should be looked at again.
 *
 * There is always a definite answer, and it is one of exactly three:
 *
 * | state | next check-in |
 * |---|---|
 * | every interval caught up | the next 17:00 — the earliest a book can change |
 * | an interval behind, within `SETTLE_WINDOW_MS` of its close | `recheckDelay` from now, never past that 17:00 |
 * | an interval behind for longer than that, or not declared, or the server said nothing | the next 17:00 |
 *
 * `watermark` of `null` is what an older server (or a header the browser could not read)
 * looks like, and it degrades to the calendar horizon — the behaviour before any of this.
 */
export function levelsStaleAt(fetchedAt: number, watermark: Watermark | null): number {
  const calendar = nextSessionAnchor(fetchedAt)
  if (watermark === null) return calendar
  let horizon = calendar
  for (const [code, through] of Object.entries(watermark)) {
    if (caughtUp(code, through, fetchedAt)) continue
    const lateBy = fetchedAt - lastClose(code, fetchedAt)
    // Long past due: this is not a bar on its way, it is a bar that is not coming.
    if (lateBy >= SETTLE_WINDOW_MS) continue
    horizon = Math.min(horizon, fetchedAt + recheckDelay(lateBy))
  }
  return horizon
}

/** Parses the `X-Levels-Computed-Through` header. Never throws: a header this cannot make
 * sense of is the same as one that is not there, which is a server that does not send it. */
export function parseWatermark(header: string | null | undefined): Watermark | null {
  if (header === null || header === undefined) return null
  const out: Record<string, number> = {}
  for (const part of header.split(',')) {
    const [code, value] = part.split('=')
    // An EMPTY value is not the "nothing consumed yet" sentinel: `Number('')` is 0, and
    // taking `1W=` to mean `1W=0` would turn a malformed header into a definite claim that
    // the feed has computed nothing, which is a claim worth polling at.
    if (!code?.trim() || !value?.trim()) continue
    const ms = Number(value)
    if (Number.isFinite(ms)) out[code.trim()] = ms
  }
  // An EMPTY header is meaningful and not the same as an absent one: the server answered and
  // named no interval, i.e. it computes none of what was asked for. That is a definite "there
  // is nothing to wait for", and an empty record produces exactly the calendar horizon.
  return out
}
