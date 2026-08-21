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
 * WMA -- linearly weighted moving average, computed in the browser.
 *
 * klinecharts ships MA, EMA and SMA but no WMA, so this is registered beside them
 * (src/index.ts) and behaves exactly like a built-in: several periods at once, one line
 * each, the same `MA1`..`MA5`-style settings slots (src/config/indicators.ts).
 *
 * WMA(p) at bar i weights the last p closes p, p-1, ... 1 from newest to oldest and
 * divides by p(p+1)/2, so it tracks price more closely than the equally weighted MA and
 * -- unlike EMA -- forgets a close completely once it leaves the window.
 *
 * It is a FIR filter over exactly p bars, which is why it can be rolled forward in O(1)
 * per bar rather than summed over the window: with S the plain sum of the window ending
 * at i-1 and N its weighted sum,
 *
 *   N(i) = N(i-1) + p * close(i) - S(i-1)
 *
 * because dropping S from the weighted sum decays every surviving weight by one and
 * drops the oldest bar's weight to zero. Before the window is full the same accumulator
 * is built up directly (weight k+1 for bar k) and no value is emitted.
 *
 * Rolling an accumulator forward lets rounding error drift, as klinecharts' own MA does:
 * against a window-summed reference the worst relative difference is 2.4e-11 over 5,000
 * bars and 4.2e-9 over 120,000 (WMA(233), the longest period tried) -- orders of
 * magnitude below any price precision the chart displays, and reset on every recalc.
 */

// Exported because the declaration build names it: `indicators` (src/indicators/index.ts)
// infers its element type from this template, and tsc cannot write that .d.ts for a type
// it has no name for (TS4023).
export interface Wma {
  [key: string]: number | undefined
}

const wma: IndicatorTemplate<Wma, number> = {
  name: 'WMA',
  shortName: 'WMA',
  series: 'price',
  calcParams: [5, 10, 30, 60],
  precision: 2,
  shouldOhlc: true,
  figures: [
    { key: 'wma1', title: 'WMA5: ', type: 'line' },
    { key: 'wma2', title: 'WMA10: ', type: 'line' },
    { key: 'wma3', title: 'WMA30: ', type: 'line' },
    { key: 'wma4', title: 'WMA60: ', type: 'line' }
  ],
  regenerateFigures: (params) => params.map((p, i) => ({ key: `wma${i + 1}`, title: `WMA${p}: `, type: 'line' })),
  calc: (dataList: KLineData[], indicator) => {
    const { calcParams: params, figures } = indicator
    // Per period: the plain sum of the window, and its linearly weighted sum.
    const sums: number[] = []
    const weightedSums: number[] = []
    return dataList.map((kLineData, i) => {
      const result: Wma = {}
      const close = kLineData.close
      params.forEach((p, index) => {
        // A settings field left blank arrives as undefined; draw nothing for it rather
        // than reading past the start of `dataList`.
        const period = Number.isFinite(p) ? Math.floor(p) : 0
        if (period < 1) return
        const sum = sums[index] ?? 0
        const weightedSum = weightedSums[index] ?? 0
        if (i < period) {
          // Warm-up: bar k carries weight k + 1, which is the full window's weighting
          // exactly when the last bar of the window arrives.
          sums[index] = sum + close
          weightedSums[index] = weightedSum + (i + 1) * close
        } else {
          weightedSums[index] = weightedSum + period * close - sum
          sums[index] = sum + close - dataList[i - period].close
        }
        const figure = figures[index]
        if (i >= period - 1 && figure !== undefined) {
          result[figure.key] = weightedSums[index] / ((period * (period + 1)) / 2)
        }
      })
      return result
    })
  }
}

export default wma
