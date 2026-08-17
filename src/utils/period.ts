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

import type { Period } from '../types'

// Nominal duration of one Period unit in milliseconds. Shared by ChartPane's own history
// window sizing (adjustFromTo) and the sync bus's bounded seek-paging (src/sync/bus.ts) --
// both only need this as a bound, never as exact bar arithmetic, which is why months/years
// use a mean-calendar approximation rather than the market-calendar-aware canonical duration.
// `src/` never imports from `client/`, so this cannot reuse client/periods.ts's own twin,
// `resolutionDurationMs`.
const UNIT_MS: Record<string, number> = {
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
