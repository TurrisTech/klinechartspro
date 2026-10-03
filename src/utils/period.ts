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

import type { Period, SymbolInfo } from '../types'

// Nominal duration of one Period unit in milliseconds, used by ChartPane's history window
// sizing (adjustFromTo) and the sync bus's bounded seek-paging (src/sync/bus.ts) as an
// approximate bound, not exact bar arithmetic -- months and years use a mean-calendar length.
// Defined locally because `src/` cannot import from `client/`.
const UNIT_MS: Record<string, number> = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 31 * 24 * 60 * 60 * 1000,
  year: 366 * 24 * 60 * 60 * 1000
}

export function periodDurationMs(period: Period): number {
  const unit = UNIT_MS[period.timespan]
  if (unit === undefined) throw new Error(`Unsupported period timespan: ${period.timespan}`)
  return unit * period.multiplier
}

/** The periods `symbol` can be shown at: `periods` narrowed by its own `periods` list. */
export function offeredPeriods(periods: Period[], symbol: SymbolInfo | null | undefined): Period[] {
  const allowed = symbol?.periods
  return allowed ? periods.filter((item) => allowed.includes(item.text)) : periods
}

/**
 * `period` if `symbol` can be shown at it, otherwise the shortest offered period at least as
 * long (5s -> 1m), otherwise the longest offered. The one rule every writer of a pane's period
 * or symbol goes through, so a pane never asks an instrument for a series it does not hold.
 */
export function periodFor(period: Period, periods: Period[], symbol: SymbolInfo | null | undefined): Period {
  const offered = offeredPeriods(periods, symbol)
  if (offered.length === 0 || offered.some((item) => item.text === period.text)) return period
  const wanted = periodDurationMs(period)
  const byLength = [...offered].sort((a, b) => periodDurationMs(a) - periodDurationMs(b))
  return byLength.find((item) => periodDurationMs(item) >= wanted) ?? byLength[byLength.length - 1]
}
