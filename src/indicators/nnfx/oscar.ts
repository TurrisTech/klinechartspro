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

import { countParam, lwma, sma, smma } from './mt4'
import { arrow, arrowSize, drawRange, guide, guideColor, signColors } from './paint'

/**
 * OSCAR -- the OSCAR Oscillator by GenZai (TradingView, NNFX), a sub-pane oscillator, 0..100.
 *
 * Parameters: [length, smoothing], default [20, 0] -- the setting the NNFX discovery ranked best
 * for it on 8h, read through the trigger rule below (16/28 pairs positive; the script's own
 * default length is 8). `smoothing` is 0 RMA (the script's default), 1 SMA, 2 EMA, 3 WMA, 4 none.
 * See README.md in this directory.
 *
 * `rough` is where the close sits in its `length`-bar high-low range (0 at the low, 100 at the
 * high); `oscar` blends it with the bar before (two thirds of the previous value, one third of
 * this one); both are then smoothed by `smoothing` over `length`. A flat range has no position, so
 * no value.
 *
 * The signal is the NNFX list's trigger, not the bare cross: LONG when the rough line crosses up
 * through the oscar line while below 35 and the two are more than 0.5 apart, SHORT when it crosses
 * down while above 65 likewise. Each trigger is an arrow (up below the rough line, down above it);
 * the state latches from one trigger to the next. 35 and 65 are drawn as guides, 50 faintly.
 */

export const OSCAR_SMOOTHING = ['RMA', 'SMA', 'EMA', 'WMA', 'NONE'] as const

const SENSITIVITY = 0.5
const BOTTOM = 35
const TOP = 65

export interface Oscar {
  [key: string]: number | undefined
  rough?: number
  oscar?: number
  /** +1 on a long trigger bar, -1 on a short one. */
  signal?: number
  /** The latched state: +1 from a long trigger to the next short one; absent before the first. */
  trend?: number
}

export interface OscarOptions {
  length: number
  smoothing: number
}

export function oscarOptions(calcParams: readonly unknown[]): OscarOptions {
  return {
    length: countParam(calcParams[0], 20, 2),
    smoothing: Math.min(OSCAR_SMOOTHING.length - 1, countParam(calcParams[1], 0, 0))
  }
}

// Pine's ema: alpha 2/(n+1), seeded with the SMA of the first n non-NaN values (unlike MT4's).
function pineEma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const alpha = 2 / (n + 1)
  let seed = 0
  let count = 0
  let prev = 0
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue
    if (count < n) {
      seed += x[i]
      count++
      if (count < n) continue
      prev = seed / n
    } else {
      prev = alpha * x[i] + (1 - alpha) * prev
    }
    out[i] = prev
  }
  return out
}

function smooth(kind: number, x: readonly number[], n: number): number[] {
  switch (kind) {
    case 1:
      return sma(x, n)
    case 2:
      return pineEma(x, n)
    case 3:
      return lwma(x, n)
    case 4:
      return [...x]
    default:
      return smma(x, n)
  }
}

export function oscar(bars: readonly KLineData[], options: OscarOptions): Oscar[] {
  const { length: n, smoothing } = options
  const close = bars.map((b) => b.close)
  const rough = close.map((c, i) => {
    if (i < n - 1) return Number.NaN
    let hi = c
    let lo = c
    for (let j = 1; j < n; j++) {
      const v = close[i - j]
      if (v > hi) hi = v
      if (v < lo) lo = v
    }
    return hi !== lo ? ((c - lo) / (hi - lo)) * 100 : Number.NaN
  })
  const blend = rough.map((r, i) => (i === 0 ? Number.NaN : (rough[i - 1] / 3) * 2 + r / 3))
  const fast = smooth(smoothing, rough, n)
  const slow = smooth(smoothing, blend, n)

  let state = 0
  return fast.map((r, i) => {
    const row: Oscar = {}
    const s = slow[i]
    if (Number.isFinite(r)) row.rough = r
    if (Number.isFinite(s)) row.oscar = s
    if (i >= 1 && Number.isFinite(r) && Number.isFinite(s) && Number.isFinite(fast[i - 1]) && Number.isFinite(slow[i - 1])) {
      const apart = Math.abs(r - s) > SENSITIVITY
      if (r > s && fast[i - 1] <= slow[i - 1] && apart && r < BOTTOM) {
        state = 1
        row.signal = 1
      } else if (r < s && fast[i - 1] >= slow[i - 1] && apart && r > TOP) {
        state = -1
        row.signal = -1
      }
    }
    if (state !== 0) row.trend = state
    return row
  })
}

const oscarTemplate: IndicatorTemplate<Oscar, number> = {
  name: 'OSCAR',
  shortName: 'OSCAR',
  calcParams: [20, 0],
  precision: 2,
  minValue: 0,
  maxValue: 100,
  figures: [
    { key: 'rough', title: 'Rough: ', type: 'line' },
    { key: 'oscar', title: 'Oscar: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => oscar(dataList, oscarOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const color = guideColor(chart)
    guide(ctx, bounding, yAxis, TOP, color)
    guide(ctx, bounding, yAxis, BOTTOM, color)
    guide(ctx, bounding, yAxis, 50, guideColor(chart, 0.2))
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const size = arrowSize(chart)
    const result = indicator.result
    const { from, to } = drawRange(chart, result.length)
    for (let i = from; i <= to; i++) {
      const r = result[i]
      if (r?.signal === undefined || r.rough === undefined) continue
      const x = xAxis.convertToPixel(i)
      const y = yAxis.convertToPixel(r.rough)
      if (r.signal > 0) arrow(ctx, x, y + 4, size, false, up)
      else arrow(ctx, x, y - 4, size, true, down)
    }
    return false
  }
}

export default oscarTemplate
