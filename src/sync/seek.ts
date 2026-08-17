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

import type { CrosshairPoint } from './crosshair'

// Whether `timestamp` currently falls within the main pane's own visible width. The sync bus
// (src/sync/bus.ts) uses this to skip re-centring a pane that already shows the click target.
// Converts through this chart's own scale, matching seekToTimestamp below, so the two agree.
export function isTimestampVisible(chart: Chart, timestamp: number): boolean {
  const main = chart.getSize('candle_pane', 'main')
  if (!main) return false
  const { x } = chart.convertToPixel({ timestamp }, { paneId: 'candle_pane' }) as Partial<Coordinate>
  return typeof x === 'number' && x >= 0 && x <= main.width
}

// Scrolls `chart` so `timestamp` lands at the given horizontal FRACTION of the main pane's
// width (0 = left edge, 1 = right edge, 0.5 = centre), via `scrollByDistance` -- moving the
// viewport by an exact pixel distance reproduces the source pane's on-screen fraction on every
// other pane, regardless of how many bars each has loaded or what interval it's on.
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

export interface SeekTarget {
  // Where to scroll (or reload-anchor) the target pane, and at what on-screen fraction --
  // hand these straight to seekToTimestamp. For the "align a span" case this is the span's
  // MIDPOINT, not the instant that was actually clicked -- see crosshairTimestamp.
  timestamp: number
  fraction: number
  // The instant to mark with the crosshair. Usually equal to `timestamp`, EXCEPT the "align a
  // span, and it fits" case: the view centres the whole [start, end] span so both ends are
  // visible, but what the user actually clicked was `start` -- the crosshair should point at
  // that, not at the geometric midpoint used only to compute the scroll position.
  crosshairTimestamp: number
}

const CENTER_FRACTION = 0.5
// Where a higher-timeframe candle's own START lands when its full span doesn't fit the
// target pane at its current zoom -- see resolveSeekTarget's last case.
const SPAN_START_FRACTION = 0.2

// What to hand seekToTimestamp (and applyCrosshairAt) for a click that crossed timeframes,
// per src/sync/bus.ts's seekPane. Three cases, by comparing sourcePeriodMs (the pane the
// click came from) against targetPeriodMs (the pane being positioned) -- zoom (targetChart's
// own bar spacing) is never touched in any of them:
//
// - Equal timeframe: unchanged from before this existed -- reproduce the click's own
//   on-screen fraction on the target.
// - Lower timeframe -> higher: `point.timestamp` is a moment somewhere inside ONE
//   higher-timeframe candle on the target, which has no larger structure to align to -- centre
//   it.
// - Higher timeframe -> lower: the clicked candle (on the source) spans many bars on the
//   target. `point.timestamp` is that candle's own open -- crosshairPoint/convertFromPixel
//   resolve to the exact stored bar timestamp, never an interpolated one, whenever the click
//   landed inside the source's loaded data -- and its close is the SOURCE's own next loaded
//   bar, not a nominal one-period step, which would be wrong across a real market-closed gap
//   (e.g. a Friday-close weekly candle's next bar isn't until Sunday). When that whole span
//   fits within the target's own pane width at its CURRENT bar spacing, centre the VIEW on it
//   so both ends are visible -- but the crosshair still marks `start`, the instant actually
//   clicked, not the span's midpoint. When it doesn't fit, there's no span left to centre, so
//   view and crosshair agree: anchor `start` near the left edge.
export function resolveSeekTarget(
  targetChart: Chart,
  sourceChart: Chart,
  point: CrosshairPoint,
  sourcePeriodMs: number,
  targetPeriodMs: number,
  clickFraction: number
): SeekTarget {
  if (targetPeriodMs === sourcePeriodMs) {
    return { timestamp: point.timestamp, fraction: clickFraction, crosshairTimestamp: point.timestamp }
  }
  if (targetPeriodMs > sourcePeriodMs) {
    return { timestamp: point.timestamp, fraction: CENTER_FRACTION, crosshairTimestamp: point.timestamp }
  }

  const start = point.timestamp
  const sourceData = sourceChart.getDataList()
  const sourceIndex = sourceData.findIndex((bar) => bar.timestamp === start)
  const nextBar = sourceIndex >= 0 ? sourceData[sourceIndex + 1] : undefined
  const end = nextBar?.timestamp ?? start + sourcePeriodMs

  const main = targetChart.getSize('candle_pane', 'main')
  const startPixel = targetChart.convertToPixel(
    { timestamp: start },
    { paneId: 'candle_pane' }
  ) as Partial<Coordinate>
  const endPixel = targetChart.convertToPixel(
    { timestamp: end },
    { paneId: 'candle_pane' }
  ) as Partial<Coordinate>
  const spanPx =
    typeof startPixel.x === 'number' && typeof endPixel.x === 'number'
      ? endPixel.x - startPixel.x
      : Infinity

  if (main && spanPx <= main.width) {
    return { timestamp: (start + end) / 2, fraction: CENTER_FRACTION, crosshairTimestamp: start }
  }
  return { timestamp: start, fraction: SPAN_START_FRACTION, crosshairTimestamp: start }
}
