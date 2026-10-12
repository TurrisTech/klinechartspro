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

import { countParam, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, withAlpha } from './paint'

/**
 * KST -- Martin Pring's Know Sure Thing in a sub-pane, as pandas-ta computes it (windicators
 * `know_sure_thing`, the code the windicators NNFX scan ran): the C1 of the scan's system 5, at
 * ROC 10/15/40/15, smoothing 11/5/6/30, signal 4, against the signal's 3-bar average.
 *
 * Parameters: [roc1, roc2, roc3, roc4, sma1, sma2, sma3, sma4, signal, ma, inverted], default
 * [10, 15, 40, 15, 11, 5, 6, 30, 4, 3, 0] (pandas-ta's own: 10, 15, 20, 30, 10, 10, 10, 15, 9).
 *
 *   rocma_k = SMA(ROC(close, roc_k), sma_k)        ROC in percent: 100 x (close - close[r]) / close[r]
 *   kst     = 100 x (rocma1 + 2 rocma2 + 3 rocma3 + 4 rocma4)
 *   signal  = SMA(kst, signal)
 *   ma      = the plain `ma`-bar average of the signal: the scan's trigger
 *
 * The C1 reading the scan tested is the SIGNAL line against its average, the conventional way
 * round (`inverted` 0): long while the signal is above its average, short while below. The area
 * between the two is shaded in the colour of the side it gives.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Kst {
  [key: string]: number | undefined
  kst?: number
  signal?: number
  ma?: number
  state?: number
}

// pandas' rolling(n).mean() as pandas-ta's numba path writes it: the window summed oldest first,
// NaN while it holds a NaN.
function mean(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  for (let i = n - 1; i < x.length; i++) {
    let s = 0
    for (let j = i - n + 1; j <= i; j++) s += x[j]
    out[i] = s / n
  }
  return out
}

function roc(x: readonly number[], r: number): number[] {
  return x.map((v, i) => (i >= r ? (100 * (v - x[i - r])) / x[i - r] : Number.NaN))
}

const DEFAULTS = [10, 15, 40, 15, 11, 5, 6, 30, 4, 3, 0]

export function kstRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Kst[] {
  const p = DEFAULTS.map((d, i) => (i < 10 ? Math.min(100000, countParam(calcParams[i], d, 1)) : countParam(calcParams[i], d, 0)))
  const close = bars.map((b) => b.close)
  const rocma = [0, 1, 2, 3].map((k) => mean(roc(close, p[k]), p[k + 4]))
  const kst = close.map((_, i) => 100 * (rocma[0][i] + 2 * rocma[1][i] + 3 * rocma[2][i] + 4 * rocma[3][i]))
  const signal = mean(kst, p[8])
  const ma = mean(signal, p[9])
  const dir = p[10] >= 1 ? -1 : 1
  return kst.map((k, i) => {
    const row: Kst = { kst: value(k), signal: value(signal[i]), ma: value(ma[i]) }
    if (row.signal !== undefined && row.ma !== undefined) row.state = dir * Math.sign(row.signal - row.ma)
    return row
  })
}

const kst: IndicatorTemplate<Kst, number> = {
  name: 'KST',
  shortName: 'KST',
  calcParams: DEFAULTS,
  // pandas-ta's KST runs in the thousands (ROC in percent, then x 100 again).
  precision: 1,
  figures: [
    { key: 'kst', title: 'KST: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    { key: 'signal', title: 'Signal: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => kstRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const inverted = countParam(indicator.calcParams[10], 0, 0) >= 1
    const [above, below] = inverted ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'signal', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default kst
