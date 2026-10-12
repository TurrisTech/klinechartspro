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

import { countParam, realParam, value } from './mt4'
import { guide, guideColor, signColors, signLineStyle } from './paint'

/**
 * TCF -- the Trend Continuation Factor 2 in a sub-pane, as the Stonehill library's
 * `TrendContinuation2.mq4` computes it (windicators `trend_continuation_factor`, the code the
 * windicators NNFX scan ran): the C2 of the scan's systems 1 and 4, at n 15, T3 period 10,
 * b 1.0815.
 *
 * Parameters: [n, t3, b, count, inverted], default [15, 10, 1.0815, 500, 1] (the source's own:
 * 20, 5, 0.618, 5000).
 *
 * Per bar, the up-move and its running streak sum (CF+), and the down-move and its streak sum
 * (CF-). Over the last n + 1 bars, k+ = sum(up-moves) - sum(CF-) and k- = sum(down-moves) -
 * sum(CF+), each smoothed by Tillson's T3 (period t3, volume factor b) starting from zero. TCF+
 * is k+ smoothed, TCF- is k- smoothed.
 *
 * The MQL source recomputes everything on each tick over its last `count` bars only, the streaks
 * and the T3 restarting at zero there. Each bar here has the values that restart gave it while it
 * was the newest bar, as it was seen live, so nothing repaints. The scan ran count 500 (identical to
 * the source's 5000 at these settings over its six years, and ten times faster). Over the first
 * `count` bars of the chart's history the source reads the close before the oldest bar as 0, so
 * the first bar counts as a rise of the whole price: those first n + 1 bars or so are spikes.
 *
 * The C2 reading the scan tested is TCF+ against zero with `inverted` 1: it confirms LONG while
 * TCF+ is BELOW zero and short while above. `inverted` 0 is the conventional reading. TCF+ is
 * drawn in the colour of the side it gives; TCF- is context.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Tcf {
  [key: string]: number | undefined
  plus?: number
  minus?: number
  state?: number
}

export interface TcfOptions {
  n: number
  t3: number
  b: number
  count: number
}

export function tcfOptions(calcParams: readonly unknown[]): TcfOptions {
  return {
    n: Math.min(100000, countParam(calcParams[0], 15, 0)),
    t3: realParam(calcParams[1], 10, 0),
    b: realParam(calcParams[2], 1.0815, 0),
    count: Math.min(5000, countParam(calcParams[3], 500, 1))
  }
}

/** ln C(a, b), for the T3 tail bound. */
function lnChoose(a: number, b: number): number {
  let s = 0
  for (let i = 1; i <= b; i++) s += Math.log(a - b + i) - Math.log(i)
  return s
}

/**
 * TCF+ and TCF- for every bar. `exact` forces the source's restart at every bar. Otherwise, when
 * the restart cannot change a value -- the T3's six cascaded EMAs weigh an input `count - n - 1`
 * bars old by at most C(lag + 5, 5) x w2^lag, and that is below 1e-20 -- one pass over the whole
 * history gives the same values (to rounding: the restart's only effects are at the oldest bars of
 * its window, which reach the newest through that weight). At the scan's setting (count 500, n 15,
 * T3 10) the weight is ~1e-66, and the pass is ~100x faster on a long intraday history.
 */
export function trendContinuationFactor(close: readonly number[], o: TcfOptions, exact = false): { plus: number[]; minus: number[] } {
  const m = close.length
  const plus = new Array<number>(m).fill(Number.NaN)
  const minus = new Array<number>(m).fill(Number.NaN)
  if (m === 0) return { plus, minus }
  const { n, count } = o
  const b2 = o.b * o.b
  const b3 = b2 * o.b
  const c1 = -b3
  const c2 = 3 * (b2 + b3)
  const c3 = -3 * (2 * b2 + o.b + b3)
  const c4 = 1 + 3 * o.b + b3 + 3 * b2
  const n1 = 1 + 0.5 * (Math.max(1, o.t3) - 1)
  const w1 = 2 / (n1 + 1)
  const w2 = 1 - w1
  const lag = count - n - 1
  const restartIsInvisible = lag > 0 && lnChoose(lag + 5, 5) + lag * Math.log(w2) < Math.log(1e-20)
  const window = !exact && restartIsInvisible && m > count ? m : count
  // The source's local arrays, indexed by shift (0 = the call's newest bar), zero beyond its
  // window. Allocated once and cleared per call.
  const size = window + n + 2
  const changeP = new Float64Array(size)
  const changeN = new Float64Array(size)
  const cfP = new Float64Array(size)
  const cfN = new Float64Array(size)

  // One call of the source's start() with bar `newest` the newest, over `window` bars, written at
  // every bar of its window (`everyBar`) or at the newest only.
  const call = (newest: number, everyBar: boolean) => {
    changeP.fill(0)
    changeN.fill(0)
    cfP.fill(0)
    cfN.fill(0)
    let e1 = 0, e2 = 0, e3 = 0, e4 = 0, e5 = 0, e6 = 0
    let f1 = 0, f2 = 0, f3 = 0, f4 = 0, f5 = 0, f6 = 0
    // Running sums over the shifts s .. s + n (the source sums them afresh at each s).
    let chP = 0
    let chN = 0
    let cffP = 0
    let cffN = 0
    for (let s = window - 1; s >= 0; s--) {
      const t = newest - s
      const c0 = t >= 0 ? close[t] : 0
      const cp = t - 1 >= 0 ? close[t - 1] : 0
      if (c0 > cp) {
        changeP[s] = c0 - cp
        cfP[s] = changeP[s] + cfP[s + 1]
        changeN[s] = 0
        cfN[s] = 0
      } else {
        changeP[s] = 0
        cfP[s] = 0
        changeN[s] = cp - c0
        cfN[s] = changeN[s] + cfN[s + 1]
      }
      const drop = s + n + 1
      chP += changeP[s] - changeP[drop]
      chN += changeN[s] - changeN[drop]
      cffP += cfP[s] - cfP[drop]
      cffN += cfN[s] - cfN[drop]
      const kP = chP - cffN
      const kN = chN - cffP
      e1 = w1 * kP + w2 * e1
      e2 = w1 * e1 + w2 * e2
      e3 = w1 * e2 + w2 * e3
      e4 = w1 * e3 + w2 * e4
      e5 = w1 * e4 + w2 * e5
      e6 = w1 * e5 + w2 * e6
      f1 = w1 * kN + w2 * f1
      f2 = w1 * f1 + w2 * f2
      f3 = w1 * f2 + w2 * f3
      f4 = w1 * f3 + w2 * f4
      f5 = w1 * f4 + w2 * f5
      f6 = w1 * f5 + w2 * f6
      if (t >= 0 && (everyBar || s === 0)) {
        plus[t] = c1 * e6 + c2 * e5 + c3 * e4 + c4 * e3
        minus[t] = c1 * f6 + c2 * f5 + c3 * f4 + c4 * f3
      }
    }
  }
  // Up to bar count - 1 the window reaches past the oldest bar, where every change is 0 and the
  // state stays 0, so one call gives all of them; later bars each get their own call (unless the
  // window is the whole history, above).
  call(Math.min(m, window) - 1, true)
  for (let t = window; t < m; t++) call(t, false)
  return { plus, minus }
}

export function tcfRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Tcf[] {
  const { plus, minus } = trendContinuationFactor(bars.map((b) => b.close), tcfOptions(calcParams))
  const dir = countParam(calcParams[4], 1, 0) >= 1 ? -1 : 1
  return plus.map((p, i) => {
    const row: Tcf = { plus: value(p), minus: value(minus[i]) }
    if (row.plus !== undefined) row.state = dir * Math.sign(row.plus)
    return row
  })
}

const tcf: IndicatorTemplate<Tcf, number> = {
  name: 'TCF',
  shortName: 'TCF',
  calcParams: [15, 10, 1.0815, 500, 1],
  precision: 5,
  figures: [
    {
      key: 'plus',
      title: 'TCF+: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'minus', title: 'TCF-: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => tcfRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default tcf
