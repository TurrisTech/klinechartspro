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

import type { Chart, Coordinate, Crosshair, Point } from 'klinecharts'

// A synthetic paneId that names no real klinecharts sub-pane. Dispatched for a time-only sync
// (the source hover was over an indicator sub-pane, whose value has no meaning on another
// pane's price axis) so the crosshair draws its vertical line and x-axis time label (gated on
// `isString(crosshair.paneId)`) without a horizontal line or y-axis price label (gated on
// `paneId === pane.getId()`, which this never matches). `ChartImp.executeAction` only
// backfills a missing paneId (`crosshair.paneId ??= 'candle_pane'`), so this explicit value is
// never overwritten.
export const SYNC_PANE_ID = '__sync__'

// The instant, and -- only when the hover was over the main price pane -- the price, under
// the pointer on the SOURCE pane. `onCrosshairChange` subscribers receive the raw
// `{x, y, paneId}` mousemove payload; klinecharts enriches its OWN internal crosshair record
// with `timestamp`/`kLineData`, but does not pass that enriched object to the action, so
// neither can be read off `cr` directly. `convertFromPixel` recovers both via the exact same
// coordinate->dataIndex/value path klinecharts itself uses -- passing `y` alongside `x`
// populates `value` too, but only means "a price" when the pointer was actually over
// `candle_pane`: the same y coordinate over an indicator sub-pane is that indicator's own
// value (RSI 0-100, MACD around 0, ...), not a price, and must not be forwarded as one.
export interface CrosshairPoint {
  timestamp: number
  /** A price, present only when the source hover was over candle_pane. */
  value?: number
}

export function crosshairPoint(
  chart: Chart,
  cr: { x?: number; y?: number; paneId?: string }
): CrosshairPoint | undefined {
  if (typeof cr.x !== 'number') return undefined
  const onCandlePane = cr.paneId === 'candle_pane'
  const coordinate: Partial<Coordinate> =
    onCandlePane && typeof cr.y === 'number' ? { x: cr.x, y: cr.y } : { x: cr.x }
  const points = chart.convertFromPixel([coordinate], { paneId: 'candle_pane' }) as Array<Partial<Point>>
  const point = points[0]
  if (typeof point?.timestamp !== 'number') return undefined
  return onCandlePane && typeof point.value === 'number'
    ? { timestamp: point.timestamp, value: point.value }
    : { timestamp: point.timestamp }
}

// Moves a TARGET pane's crosshair to `point`. `setCrosshair` derives its position from pixel
// coordinates (`cr.x`/`cr.y`), never from timestamp/value fields, so both are first converted
// to this pane's own pixel space via `convertToPixel`, which extrapolates outside the loaded
// range/price scale using this chart's own period and y-axis. A pane with nothing loaded yet
// is skipped: its x would be meaningless.
//
// With a price (`point.value` set): dispatches with the real `'candle_pane'` id, so the
// horizontal line, the y-axis price label and the tooltip all draw too, at wherever that price
// falls on this pane's own scale -- unclamped, so it may sit outside the visible range for two
// panes on very different instruments.
//
// Without a price (source hover was over an indicator sub-pane): dispatches with the
// synthetic SYNC_PANE_ID, drawing the vertical line only.
export function applyCrosshairAt(chart: Chart, point: CrosshairPoint): void {
  if (chart.getDataList().length === 0) return
  const target: Partial<Point> =
    typeof point.value === 'number'
      ? { timestamp: point.timestamp, value: point.value }
      : { timestamp: point.timestamp }
  const coordinate = chart.convertToPixel(target, { paneId: 'candle_pane' }) as Partial<Coordinate>
  if (typeof coordinate.x !== 'number') return
  if (typeof point.value === 'number' && typeof coordinate.y === 'number') {
    chart.executeAction('onCrosshairChange', {
      x: coordinate.x,
      y: coordinate.y,
      paneId: 'candle_pane'
    } as Crosshair)
  } else {
    chart.executeAction('onCrosshairChange', { x: coordinate.x, paneId: SYNC_PANE_ID } as Crosshair)
  }
}

// Clears a target pane's synced crosshair by dispatching `undefined`: `setCrosshair`'s
// `isValid(undefined)` is false, so the stored crosshair loses x/y/paneId and nothing draws.
export function clearCrosshair(chart: Chart): void {
  chart.executeAction('onCrosshairChange', undefined as unknown as Crosshair)
}
