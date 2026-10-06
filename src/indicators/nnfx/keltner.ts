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

import { countParam, realParam, sma, value } from './mt4'
import { drawRange, flipArrows, signColors, trendAges } from './paint'

/**
 * KELTNER -- the Keltner Channel on the price pane, as the `ta` library computes it (the version
 * the NNFX study tested), with the mid-line coloured by its slope: System B's C1.
 *
 * Parameters: [window, version, atr, mult, arrows], default [20, 0, 10, 2, 1].
 *
 * `version` 0 is Chester Keltner's original, `ta`'s default and what the study ran:
 *   mid   = SMA(window) of the typical price (high + low + close) / 3;
 *   upper = SMA(window) of (4 high - 2 low + close) / 3;
 *   lower = SMA(window) of (-2 high + 4 low + close) / 3.
 * `atr` and `mult` are unused by it (the study's "window_atr" changed nothing).
 * `version` 1 is the modern channel, `ta`'s original_version=False: an EMA(window) of the close,
 * seeded with the first close, with bands mult x ATR(atr) either side -- Wilder's ATR as `ta`
 * computes it (the first value the mean of the first `atr` true ranges).
 *
 * The NNFX signal is the mid-line's SLOPE: long while it is higher than the bar before (up colour),
 * short while lower (down colour); an unchanged bar keeps the colour. On the original version the
 * slope's sign is the typical price against the one `window` bars earlier. `arrows` 1 marks each
 * turn of the slope on the bar, as the C1 flip that bar would trigger. Locked to `ta` by
 * fixtures/library_parity.json; the bands are drawn from the first full window (`ta` averages a
 * partial window there).
 */

export interface Keltner {
  [key: string]: number | undefined
  upper?: number
  mid?: number
  lower?: number
  /** +1 while the mid-line rises, -1 while it falls, held over an unchanged bar. */
  slope?: number
  age?: number
}

export interface KeltnerOptions {
  window: number
  version: number
  atr: number
  mult: number
}

export function keltnerOptions(calcParams: readonly unknown[]): KeltnerOptions {
  return {
    window: countParam(calcParams[0], 20, 1),
    version: Math.min(1, countParam(calcParams[1], 0, 0)),
    atr: countParam(calcParams[2], 10, 1),
    mult: realParam(calcParams[3], 2, 0)
  }
}

// `ta`'s AverageTrueRange: true range with the first bar's being its high - low, the first value
// the mean of the first n, then Wilder's (prev * (n - 1) + TR) / n.
function taAtr(bars: readonly KLineData[], n: number): number[] {
  const tr = bars.map((bar, i) =>
    i === 0
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close))
  )
  const out = new Array<number>(bars.length).fill(Number.NaN)
  if (bars.length < n) return out
  let prev = 0
  for (let i = 0; i < n; i++) prev += tr[i]
  prev /= n
  out[n - 1] = prev
  for (let i = n; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr[i]) / n
    out[i] = prev
  }
  return out
}

// pandas' ewm(span=n, adjust=False): seeded with the first value, shown from the n-th.
function ewmSpan(x: readonly number[], n: number): number[] {
  const alpha = 2 / (n + 1)
  let prev = Number.NaN
  return x.map((v, i) => {
    prev = Number.isNaN(prev) ? v : alpha * v + (1 - alpha) * prev
    return i >= n - 1 ? prev : Number.NaN
  })
}

export function keltnerChannel(bars: readonly KLineData[], options: KeltnerOptions): Keltner[] {
  const { window, version, mult } = options
  let mid: number[]
  let upper: number[]
  let lower: number[]
  if (version === 0) {
    mid = sma(bars.map((b) => (b.high + b.low + b.close) / 3.0), window)
    upper = sma(bars.map((b) => (4 * b.high - 2 * b.low + b.close) / 3.0), window)
    lower = sma(bars.map((b) => (-2 * b.high + 4 * b.low + b.close) / 3.0), window)
  } else {
    mid = ewmSpan(bars.map((b) => b.close), window)
    const atr = taAtr(bars, options.atr)
    upper = mid.map((m, i) => m + mult * atr[i])
    lower = mid.map((m, i) => m - mult * atr[i])
  }
  let slope = 0
  const rows: Keltner[] = mid.map((m, i) => {
    if (i > 0 && Number.isFinite(m) && Number.isFinite(mid[i - 1])) {
      if (m > mid[i - 1]) slope = 1
      else if (m < mid[i - 1]) slope = -1
    }
    const row: Keltner = { upper: value(upper[i]), mid: value(m), lower: value(lower[i]) }
    if (slope !== 0 && row.mid !== undefined) row.slope = slope
    return row
  })
  trendAges(rows.map((r) => r.slope)).forEach((age, i) => {
    if (age !== undefined) rows[i].age = age
  })
  return rows
}

const keltner: IndicatorTemplate<Keltner, number> = {
  name: 'KELTNER',
  shortName: 'Keltner',
  series: 'price',
  calcParams: [20, 0, 10, 2, 1],
  precision: 5,
  figures: [
    { key: 'upper', title: 'Upper: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    {
      key: 'mid',
      title: 'Mid: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => {
        const { up, down, flat } = signColors(indicator, defaultStyles)
        const s = data.current?.slope ?? 0
        return { color: s > 0 ? up : s < 0 ? down : flat, size: 2 }
      }
    },
    { key: 'lower', title: 'Lower: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => keltnerChannel(dataList, keltnerOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    if (indicator.calcParams[4] === 0) return false
    const result = indicator.result
    flipArrows(ctx, chart, xAxis, yAxis, result.map((r) => r?.slope), drawRange(chart, result.length),
      signColors(indicator, chart.getStyles().indicator))
    return false
  }
}

export default keltner
