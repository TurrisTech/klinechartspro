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

import type { IndicatorTemplate, KLineData } from 'klinecharts'

/**
 * SWING (shown as "Tops and Bottoms") -- swing tops and bottoms, computed in the browser and marked on the price pane.
 *
 * Parameters: [left, right, marker], default [10, 10, 0].
 *
 * A bar is a TOP when its high clears the highs of the `left` bars before it and of the
 * `right` bars after it; a BOTTOM is the same with lows. "Clears" is strict against history
 * and inclusive against the future (high > every earlier high, >= every later one), so a
 * run of equal highs yields exactly one top -- its first bar -- rather than none or several.
 * A bar with fewer than `left` bars before it or `right` after it is never marked: its
 * window is not full, and marking it would claim a swing the data cannot show.
 *
 * `marker` chooses what is drawn:
 *   0 -- a circle around the top's high / the bottom's low, on the swing bar itself;
 *   1 -- a signal arrow on the bar that CONFIRMS the swing, `right` bars later (down arrow
 *        above that bar's high for a top, up arrow below its low for a bottom);
 *   2 -- both.
 * The two differ on purpose. The circle is where the extreme was; the signal is when it
 * became knowable -- a top needs its `right` bars to have closed before it is a top at all,
 * so a signal on the swing bar itself would be `right` bars of lookahead. On the live edge
 * the forming bar counts towards those `right` bars, so a top confirmed by it can still be
 * withdrawn if that bar goes on to trade above it.
 *
 * Each test is a sliding-window extreme (monotonic deque), so a recalc is O(n) whatever the
 * window sizes, not O(n * (left + right)).
 */

// Exported because the declaration build names it (TS4023) -- see src/indicators/wma.ts.
// The index signature lets `indicators` (src/indicators/index.ts) hold it beside WMA.
export interface Swing {
  [key: string]: number | undefined
  top?: number
  bottom?: number
}

const DEFAULT_LEFT = 10
const DEFAULT_RIGHT = 10

export const SWING_MARKER_CIRCLE = 0
export const SWING_MARKER_SIGNAL = 1
export const SWING_MARKER_BOTH = 2

function windowParam(value: unknown, fallback: number): number {
  // A settings field left blank arrives as undefined.
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

/**
 * For every bar, whether `values[i]` beats all of the `left` values before it strictly and
 * all of the `right` values after it inclusively, where `beats` is `>` for highs. Lows are
 * passed negated. Bars without full windows on both sides are false.
 */
export function swingMask(values: readonly number[], left: number, right: number): boolean[] {
  const n = values.length
  const mask = new Array<boolean>(n).fill(false)
  if (n === 0) return mask

  // History: deque of indices in [i - left, i - 1], values non-increasing from the front.
  const clearsLeft = new Array<boolean>(n).fill(false)
  const back: number[] = []
  let head = 0
  for (let i = 0; i < n; i++) {
    while (head < back.length && back[head] < i - left) head++
    clearsLeft[i] = i >= left && (head === back.length || values[i] > values[back[head]])
    while (back.length > head && values[back[back.length - 1]] <= values[i]) back.pop()
    back.push(i)
  }

  // Future: deque of indices in [i + 1, i + right], scanned from the end.
  const ahead: number[] = []
  head = 0
  for (let i = n - 1; i >= 0; i--) {
    while (head < ahead.length && ahead[head] > i + right) head++
    const clearsRight = i + right <= n - 1 && (head === ahead.length || values[i] >= values[ahead[head]])
    mask[i] = clearsLeft[i] && clearsRight
    while (ahead.length > head && values[ahead[ahead.length - 1]] <= values[i]) ahead.pop()
    ahead.push(i)
  }
  return mask
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()
}

// A filled triangle whose tip is at (x, y), pointing down for a top and up for a bottom.
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, down: boolean, color: string): void {
  const base = down ? y - size : y + size
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size * 0.7, base)
  ctx.lineTo(x + size * 0.7, base)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

const swing: IndicatorTemplate<Swing, number> = {
  name: 'SWING',
  // `name` stays SWING: saved layouts record indicators by it. Only the label changed.
  shortName: 'Tops and Bottoms',
  series: 'price',
  calcParams: [DEFAULT_LEFT, DEFAULT_RIGHT, SWING_MARKER_CIRCLE],
  precision: 2,
  shouldOhlc: false,
  // No `type`: the values appear in the tooltip, and `draw` below is the only rendering.
  figures: [
    { key: 'top', title: 'Top: ' },
    { key: 'bottom', title: 'Bottom: ' }
  ],
  calc: (dataList: KLineData[], indicator) => {
    const [leftParam, rightParam] = indicator.calcParams
    const left = windowParam(leftParam, DEFAULT_LEFT)
    const right = windowParam(rightParam, DEFAULT_RIGHT)
    const tops = swingMask(dataList.map((bar) => bar.high), left, right)
    const bottoms = swingMask(dataList.map((bar) => -bar.low), left, right)
    return dataList.map((bar, i) => {
      const result: Swing = {}
      if (tops[i]) result.top = bar.high
      if (bottoms[i]) result.bottom = bar.low
      return result
    })
  },
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    const data = chart.getDataList()
    const result = indicator.result
    const right = windowParam(indicator.calcParams[1], DEFAULT_RIGHT)
    const markerParam = indicator.calcParams[2]
    const marker = markerParam === SWING_MARKER_SIGNAL || markerParam === SWING_MARKER_BOTH ? markerParam : SWING_MARKER_CIRCLE
    const drawCircles = marker !== SWING_MARKER_SIGNAL
    const drawSignals = marker !== SWING_MARKER_CIRCLE

    // Tops take the theme's down colour and bottoms its up colour, so the marks follow the
    // candles through a theme or colour-scheme change.
    const { upColor, downColor } = chart.getStyles().candle.bar
    const barWidth = chart.getBarSpace().bar
    const radius = Math.max(4, Math.min(12, barWidth * 0.8))
    const arrowSize = Math.max(5, Math.min(10, barWidth * 0.8))
    const gap = 3

    const range = chart.getVisibleRange()
    const from = Math.max(0, range.realFrom - 1)
    const to = Math.min(data.length - 1, range.realTo + 1)
    for (let i = from; i <= to; i++) {
      const x = xAxis.convertToPixel(i)
      if (drawCircles) {
        const value = result[i]
        if (value?.top !== undefined) circle(ctx, x, yAxis.convertToPixel(value.top), radius, downColor)
        if (value?.bottom !== undefined) circle(ctx, x, yAxis.convertToPixel(value.bottom), radius, upColor)
      }
      if (drawSignals && i - right >= 0) {
        // The swing `right` bars back is confirmed by this bar's close.
        const swingBar = result[i - right]
        const bar = data[i]
        if (swingBar?.top !== undefined) arrow(ctx, x, yAxis.convertToPixel(bar.high) - gap, arrowSize, true, downColor)
        if (swingBar?.bottom !== undefined) arrow(ctx, x, yAxis.convertToPixel(bar.low) + gap, arrowSize, false, upColor)
      }
    }
    return true
  }
}

export default swing
