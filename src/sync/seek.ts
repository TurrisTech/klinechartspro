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

import type { Chart, Coordinate, Point } from 'klinecharts'

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
// Where the newest bar sits when a pane is put back at the present: four fifths across, with
// a clear fifth to its right, because a live candle is still forming and that room is where it
// forms. ChartPane's jump-to-live control and positionAtLive use it, and so does
// resolveSeekReach below -- one constant, so "the default position for the current bar" means
// the same thing however the pane got there.
export const LIVE_EDGE_FRACTION = 0.8
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

// The instant currently under the horizontal CENTRE of `chart`'s main price area -- what auto
// time sync (src/sync/bus.ts's broadcastPan) carries between panes. The midpoint rather than
// an edge because it is the one point every pane can reproduce regardless of how wide it is
// or how many bars it has loaded: aligning left edges makes a narrow pane show a strict
// prefix of a wide one, whereas aligning midpoints keeps the same moment in the middle of
// both. Resolved through this chart's own scale (the same convertFromPixel path the crosshair
// uses), so it extrapolates past the loaded range instead of clamping to the last bar.
export function visibleMidpointTimestamp(chart: Chart): number | null {
  const main = chart.getSize('candle_pane', 'main')
  if (!main || main.width === 0) return null
  const points = chart.convertFromPixel(
    [{ x: main.width * CENTER_FRACTION }],
    { paneId: 'candle_pane' }
  ) as Array<Partial<Point>>
  const timestamp = points[0]?.timestamp
  return typeof timestamp === 'number' ? timestamp : null
}

// What a pane should do with a seek target it cannot reach by scrolling -- see ChartPane's
// seekTo, its only caller. Everything here turns on ONE question the bus cannot answer for
// itself: is `target` past the newest bar THERE IS, or merely past the newest bar this pane
// happens to hold? Only the pane knows, because only the pane knows whether a seek has parked
// its data short of the present (`parkedInHistory`).
//
// - 'reload': the target sits somewhere the pane could hold but doesn't -- older than its
//   oldest bar, or newer than a tail that is itself parked in the past. Replace the data
//   around it, which is what click-to-scroll has always done.
// - 'stay' / 'live-edge': the target is past the live edge, so there is nothing there to
//   scroll to and nothing to fetch. Scrolling anyway does not even produce the blank future
//   it asks for: klinecharts clamps the view at `minVisibleBarCount.left` (two bars), so the
//   pane lands with the newest bar jammed against the LEFT edge and a screenful of nothing
//   after it. So the newest bar keeps the position it already had ('stay') -- but only when
//   that position is one it can be left in, meaning at LIVE_EDGE_FRACTION or right of it.
//   Anywhere left of that, including a pane already sitting in exactly the jammed state this
//   is meant to prevent, comes back to the live edge ('live-edge'), which is as far forward as
//   the pane can meaningfully go.
export type SeekReach = 'reload' | 'stay' | 'live-edge'

export function resolveSeekReach(
  target: number,
  newest: number | undefined,
  parkedInHistory: boolean,
  newestFraction: number | null
): SeekReach {
  // No data at all, or a target the pane's own history brackets or precedes: an ordinary
  // reload, unchanged from before this existed.
  if (newest === undefined || target <= newest) return 'reload'
  // Past this pane's tail, but the tail is parked short of the present -- the target may well
  // be real, and only a reload can reach it.
  if (parkedInHistory) return 'reload'
  // Past the live edge. Standing still is only the right answer when the current bar is
  // ALREADY at rest: on screen, and no further left than where jump-to-live would put it.
  // Both halves matter. "On screen" alone is not enough -- a pane left scrolled into the void
  // has its current bar two bars from the LEFT edge (klinecharts' own clamp), which is on
  // screen and is exactly the state this rule exists to undo, so a seek that arrives while the
  // pane is already in it must repair it rather than confirm it. And "at or past the fraction"
  // alone is not enough either -- a pane parked far enough back that its current bar is off to
  // the RIGHT scores arbitrarily high and would be left showing history.
  if (newestFraction === null) return 'live-edge'
  return newestFraction >= LIVE_EDGE_FRACTION && newestFraction <= 1 ? 'stay' : 'live-edge'
}

// Where `timestamp` currently sits across the main pane, as a fraction of its width (0 = left
// edge, 1 = right edge; outside 0..1 when it is off screen). The measurement resolveSeekReach
// judges "at rest" by -- same convertToPixel path as isTimestampVisible, so the two agree.
export function timestampFraction(chart: Chart, timestamp: number): number | null {
  const main = chart.getSize('candle_pane', 'main')
  if (!main || main.width === 0) return null
  const { x } = chart.convertToPixel({ timestamp }, { paneId: 'candle_pane' }) as Partial<Coordinate>
  return typeof x === 'number' ? x / main.width : null
}
