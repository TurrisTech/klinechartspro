import type { CandleGrid } from '../time/timeframes'

// PURE. When zones read under a bar replay's read clock stop being the server's answer.
//
// The zone documents are written by hand (wtradingresearch bin/levels2_zones.py), so live there
// is no boundary at which they change and no watermark on the wire to ask about; that half is
// still the controller's fallback timer (chartlayers/types.ts `staleAt`). Under a read clock
// there is one, and it is the server's own: `/levels2` answers every stored zone AS IT STOOD at
// the clock (wdashboard-server services/levels2.py `clamp_zone_asof`) -- a zone exists from its
// `effectiveAt`, and its touches, breaks and retirement count from their own stamps, each the
// open after the bar that decided it -- and it tests every stamp of a `code` zone against ONE
// instant per (interval, clock), `services/asof.py` `known_next_start_ms`. That instant is the
// producer's watermark under the clock, and two clocks at which it is the same for every
// interval read are answered identically, whatever lies between them: so this is a validator,
// compared like an ETag, never a horizon guessed from the calendar.

/** The latest stamp a `code` zone's events can carry and still count under read clock `clock`:
 * the open after the last `code` bar closed by `clock` -- the open after the bar forming at the
 * clock once that bar has closed (the clock at its close, or in the closed window after it), else
 * that bar's own open. `known_next_start_ms`, on the instrument's own grid; it moves exactly when
 * a `code` bar closes, which is when the server's answer can change. */
export function zonesKnownThrough(code: string, clock: number, grid: CandleGrid): number {
  const open = grid.start(code, clock)
  return grid.end(code, open) <= clock ? grid.nextStart(code, open) : open
}

/** What decides the server's answer for zones on `intervals` under read clock `clock`: the
 * instant each interval's events are known through. Equal tokens, equal answers. With no
 * schedule for the instrument nothing can be worked out, and the clock itself is the token, so
 * every move of it reads again: a read too many costs a request, a read too few draws a zone as
 * it was before the replay got here. */
export function zonesClockToken(clock: number, intervals: readonly string[], grid: CandleGrid | null): string {
  if (!grid) return `clock=${clock}`
  return intervals.map((code) => `${code}=${zonesKnownThrough(code, clock, grid)}`).join(',')
}
