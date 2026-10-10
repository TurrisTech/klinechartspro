/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { DayGeometry, Period } from '../types'

// What a timestamp on a pane's bar axis MEANS, so the wall can carry an instant from one pane
// to another.
//
// The two are not the same clock. Intraday bars are labelled by their open, but daily-and-
// coarser bars by their session date: 00:00, on the instrument's own calendar, of the session
// the candle belongs to (wdashboard-server's services/wiredate.py). For the FX week that
// midnight is SEVEN HOURS after the candle opens -- EURUSD's 1D bar dated 2026-10-09 opens at
// 17:00 New York on 10-08 -- so a 1D hover handed to a 1h pane as its raw label put the 1h
// crosshair at 00:00 on the session date, seven hours into the candle, instead of at the
// 17:00 it opened. A crypto day is dated by its open (no shift); a US equity day opens at
// 09:00 on its date (-9h). The shift is the instrument's own `DayGeometry.openOffset`,
// negated, which is the number the server derives it from.
//
// Between two session-dated panes the label itself is the common clock, and passes unchanged:
// a session date names the same trading day on both, which their opens need not. An FX day
// opens at 17:00 New York the evening before a crypto day of the same date opens at midnight
// UTC, so by its open EURUSD 10-09 falls in BTCUSD's 10-08 -- but the two sessions share all
// but the first three or four hours of EURUSD's, and a reader comparing daily bars means the date.
export interface PaneClock {
  /** Whether the pane's bars are labelled by session date (daily and coarser) rather than by
   * their open. */
  sessionDated: boolean
  /** Milliseconds from a bar's open to its label: +7h for the FX week, 0 for crypto, -9h for
   * US equities, and 0 for every intraday pane. */
  labelShiftMs: number
}

const HOUR_MS = 3_600_000
const SESSION_DATED = new Set(['day', 'week', 'month', 'year'])

// An instrument whose schedule the server could not resolve has no `dayGeometry`, and its
// session-dated labels are then read as their own opens -- the behaviour before this existed,
// not a guess at a zone the database does not state.
export function paneClock(
  period: Pick<Period, 'timespan'>,
  symbol?: { dayGeometry?: DayGeometry } | null
): PaneClock {
  const sessionDated = SESSION_DATED.has(period.timespan)
  const openOffset = symbol?.dayGeometry?.openOffset
  // `0 - offset`, not `-offset`: a crypto day's offset is 0, and -0 is not 0 to Object.is.
  const labelShiftMs = sessionDated && openOffset !== undefined ? (0 - openOffset) * HOUR_MS : 0
  return { sessionDated, labelShiftMs }
}

/** A timestamp on `from`'s bar axis, restated on `to`'s. */
export function translateTimestamp(timestamp: number, from: PaneClock, to: PaneClock): number {
  if (from.sessionDated && to.sessionDated) return timestamp
  return timestamp - from.labelShiftMs + to.labelShiftMs
}
