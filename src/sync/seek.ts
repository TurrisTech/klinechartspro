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

import type { Chart, Coordinate } from 'klinecharts'

// Whether `timestamp` currently falls within the main pane's own visible width -- the gate
// for the sync bus's "scroll only when off screen" rule (src/sync/bus.ts): a click landing on
// a date every other pane can already see should leave those viewports alone rather than
// re-centring them on every click. Converts through this chart's OWN scale, exactly like
// seekToTimestamp below, so it agrees with what that function would actually do.
export function isTimestampVisible(chart: Chart, timestamp: number): boolean {
  const main = chart.getSize('candle_pane', 'main')
  if (!main) return false
  const { x } = chart.convertToPixel({ timestamp }, { paneId: 'candle_pane' }) as Partial<Coordinate>
  return typeof x === 'number' && x >= 0 && x <= main.width
}

// Scrolls `chart` so `timestamp` lands at the given horizontal FRACTION of the main pane's
// width (0 = left edge, 1 = right edge, 0.5 = centre) -- not `chart.scrollToTimestamp`, which
// always right-aligns the target bar (it is built on scrollToDataIndex, whose distance
// calculation drives the target to the right edge by construction). `scrollByDistance` moves
// the viewport by exactly the given number of pixels, so the source pane's own on-screen
// fraction can be reproduced on every other pane regardless of how many bars each has loaded
// or what interval it's on.
export function seekToTimestamp(
  chart: Chart,
  timestamp: number,
  fraction: number,
  animationMs = 0
): void {
  const main = chart.getSize('candle_pane', 'main')
  if (!main) return
  const { x } = chart.convertToPixel({ timestamp }, { paneId: 'candle_pane' }) as Partial<Coordinate>
  if (typeof x !== 'number') return
  chart.scrollByDistance(main.width * fraction - x, animationMs)
}
