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
// pane's price axis) so the crosshair draws its VERTICAL line and x-axis time label (both
// gated on `isString(crosshair.paneId)`) without also drawing a horizontal line or y-axis
// price label (both gated on `paneId === pane.getId()`, which this can never match). Every
// consumer of `crosshair.paneId` in klinecharts 10.0.0 is one of those two gate shapes -- none
// index a map by it unguarded -- so this is a deliberate, verified choice, not a placeholder.
// `ChartImp.executeAction` only backfills a MISSING paneId (`crosshair.paneId ??=
// 'candle_pane'`), so an explicit value here is never overwritten.
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

// Moves a TARGET pane's crosshair to `point`. `setCrosshair` (which
// `executeAction('onCrosshairChange', ...)` calls into) derives its position from
// `cr.x`/`cr.y` -- PIXEL coordinates -- never from timestamp/value fields, so both must first
// be converted to THIS pane's own pixel space via `convertToPixel`, which extrapolates
// outside the loaded range/price scale using this chart's own period and y-axis. A pane with
// nothing loaded yet is skipped: its x would be meaningless.
//
// With a price (`point.value` set): dispatches with the real `'candle_pane'` id, so the
// horizontal line, the y-axis price label and the tooltip all draw too, at wherever that
// price falls on THIS pane's own scale -- which may be far outside the visible range for two
// panes on very different instruments, and is not clamped, by design: the line should track
// the source's actual price, not a screen-relative approximation of it.
//
// Without a price (source hover was over an indicator sub-pane): falls back to the
// synthetic SYNC_PANE_ID, vertical line only -- there is no price to place a horizontal line
// at.
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

// Clears a target pane's synced crosshair. MUST dispatch `undefined`, not `{}` --
// `setCrosshair`'s `isValid(undefined)` is false, so the stored crosshair loses x/y/paneId
// and nothing draws; `isValid({})` is true, so an empty object instead defaults `paneId` to
// 'candle_pane' and falls back `dataIndex` to the chart's LAST bar (no `x` given), pinning
// the crosshair to the newest candle instead of clearing it.
export function clearCrosshair(chart: Chart): void {
  chart.executeAction('onCrosshairChange', undefined as unknown as Crosshair)
}
