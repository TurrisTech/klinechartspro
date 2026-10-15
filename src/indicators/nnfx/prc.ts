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

import type { IndicatorFigureStyle, IndicatorTemplate, KLineData } from 'klinecharts'

import { countParam, realParam } from './mt4'
import { signColors, signLineStyle } from './paint'
import { sideOf } from './swami'

/**
 * PRC -- Sierra Chart's polynomial regression channel on the price pane (windicators
 * `polynomial_regression_channel`, the code the windicators NNFX scan ran;
 * scsf_PolynomialRegressionChannel, Studies5.cpp, the MetaTrader i-Regr channel): the C2 of the
 * scan's best system with a real baseline (band-stop 24 + Trendilo + this, +2.92 %/yr per pair,
 * 26 of 28 pairs) and of its fourth (band-stop 24 + MICD + this, +2.75, 22/28), at degree 2,
 * period 300.
 *
 * Parameters: [degree, period, deviations1, deviations2, redraw, inverted], default
 * [2, 300, 1.08406, 1.34, 1, 1] (the source's own: 3, 150, 1.618, 2, redraw on). The scan's
 * deviations1 is 1.0840600000000002 (1.618 x 0.67); 1.08406 gives windicators' identical output.
 *
 * On every bar from bar `period`, a least-squares polynomial of degree 1-4 through the last
 * period + 1 closes against the lag n = 0 .. period (0 = this bar): the normal equations in the
 * power sums of n, solved by Gaussian elimination with partial pivoting, all in the source's order.
 *
 *   middle        = the fit at lag 0, this bar
 *   upper/lower k = middle +/- deviations_k x RMS distance of the window's closes from the line
 *
 * `redraw` 1 (Sierra's "Use Redraw", the scan's setting): what Sierra drew at each bar when that
 * bar was the newest, with the bands at the current fit's RMS residual. `redraw` 0: the line is the
 * same, but the bands measure the closes against the line as drawn on the window's earlier bars.
 * Sierra counts the bars not drawn yet as 0, so in that mode its bands are enormous for the first
 * `period` bars after the line starts; the template leaves them blank there, until bar 2 x period.
 * That is the template's one departure from windicators. The scan read only the line: the
 * deviations move the bands, not the reading.
 *
 * The C2 reading the scan tested is the close against the middle line with `inverted` 1: it
 * confirms LONG while the close is BELOW the 300-bar quadratic's end point, short while above; 0 is
 * the conventional reading. The line is drawn in the colour of the side it gives; the bands are
 * context. The window is FIR (period + 1 bars), so there is no warm-up: the line starts at bar
 * `period`, the 301st bar at the default, and matches the scan's from there.
 *
 * Locked to windicators by fixtures/wscan_r3_cycle.json (its 250 bars are shorter than the
 * default's window, so the default case checks that nothing is drawn on them; the same quadratic
 * at period 240 checks the long-window values).
 */

export interface Prc {
  [key: string]: number | undefined
  middle?: number
  upper1?: number
  lower1?: number
  upper2?: number
  lower2?: number
  state?: number
}

export interface PrcLines {
  middle: number[]
  upper1: number[]
  lower1: number[]
  upper2: number[]
  lower2: number[]
}

const DEFAULTS = [2, 300, 1.08406, 1.34, 1, 1]

/** windicators' `_prc`, 1-based as the source. */
export function polynomialRegressionChannel(
  close: readonly number[],
  degree: number,
  period: number,
  dev1: number,
  dev2: number,
  redraw: boolean
): PrcLines {
  const n = close.length
  const out: PrcLines = {
    middle: new Array<number>(n).fill(Number.NaN),
    upper1: new Array<number>(n).fill(Number.NaN),
    lower1: new Array<number>(n).fill(Number.NaN),
    upper2: new Array<number>(n).fill(Number.NaN),
    lower2: new Array<number>(n).fill(Number.NaN)
  }
  const nn = degree + 1
  const ai = new Float64Array(100) // ai[i][j] at i * 10 + j
  const b = new Float64Array(10)
  const x = new Float64Array(10)
  const sx = new Float64Array(20)
  sx[1] = period + 1
  for (let i = 1; i <= nn * 2 - 2; i++) {
    let s = 0
    for (let m = 0; m <= period; m++) s += m ** i
    sx[i + 1] = s
  }
  // pow(m, k) for k = 0 .. degree, as the source calls it for each term.
  const pw: Float64Array[] = []
  for (let k = 0; k <= degree; k++) {
    const row = new Float64Array(period + 1)
    for (let m = 0; m <= period; m++) row[m] = m ** k
    pw.push(row)
  }
  const drawn = new Float64Array(n) // Subgraph_Fx as drawn bar by bar (redraw off)
  const fx = new Float64Array(period + 1) // this bar's fit at lag 0 .. period (redraw on)
  for (let t = period; t < n; t++) {
    for (let i = 1; i <= nn; i++) {
      let s = 0
      for (let m = 0; m <= period; m++) {
        if (i === 1) s += close[t - m]
        else s += close[t - m] * pw[i - 1][m]
      }
      b[i] = s
    }
    for (let j = 1; j <= nn; j++) for (let i = 1; i <= nn; i++) ai[i * 10 + j] = sx[i + j - 1]
    let solved = true
    for (let k = 1; k < nn; k++) {
      let ll = 0
      let mm = 0
      for (let i = k; i <= nn; i++) {
        if (Math.abs(ai[i * 10 + k]) > mm) {
          mm = Math.abs(ai[i * 10 + k])
          ll = i
        }
      }
      if (ll === 0) {
        solved = false // the study returns without drawing this bar
        break
      }
      if (ll !== k) {
        for (let j = 1; j <= nn; j++) {
          const tt = ai[k * 10 + j]
          ai[k * 10 + j] = ai[ll * 10 + j]
          ai[ll * 10 + j] = tt
        }
        const tt = b[k]
        b[k] = b[ll]
        b[ll] = tt
      }
      for (let i = k + 1; i <= nn; i++) {
        const qq = ai[i * 10 + k] / ai[k * 10 + k]
        for (let j = 1; j <= nn; j++) ai[i * 10 + j] = j === k ? 0 : ai[i * 10 + j] - qq * ai[k * 10 + j]
        b[i] = b[i] - qq * b[k]
      }
    }
    if (!solved) continue
    x[nn] = b[nn] / ai[nn * 10 + nn]
    for (let i = nn - 1; i >= 1; i--) {
      let tt = 0
      for (let j = 1; j <= nn - i; j++) {
        tt = tt + ai[i * 10 + i + j] * x[i + j]
        x[i] = (1 / ai[i * 10 + i]) * (b[i] - tt)
      }
    }
    let sq = 0
    let mid: number
    if (redraw) {
      for (let m = 0; m <= period; m++) {
        let s = 0
        for (let k = 1; k <= degree; k++) s += x[k + 1] * pw[k][m]
        fx[m] = x[1] + s
      }
      mid = fx[0]
      for (let m = 0; m <= period; m++) {
        const d = close[t - m] - fx[m]
        sq += d * d
      }
    } else {
      let s = 0
      for (let k = 1; k <= degree; k++) s += x[k + 1] * 0 ** k
      drawn[t] = x[1] + s
      mid = drawn[t]
      for (let m = 0; m <= period; m++) {
        const d = close[t - m] - drawn[t - m]
        sq += d * d
      }
    }
    sq = Math.sqrt(sq / (period + 1))
    const sq1 = sq * dev1
    const sq2 = sq * dev2
    out.middle[t] = mid
    out.upper1[t] = mid + sq1
    out.lower1[t] = mid - sq1
    out.upper2[t] = mid + sq2
    out.lower2[t] = mid - sq2
  }
  return out
}

export function prcSettings(calcParams: readonly unknown[]): {
  degree: number
  period: number
  dev1: number
  dev2: number
  redraw: boolean
  dir: number
} {
  const degree = Math.min(4, countParam(calcParams[0], DEFAULTS[0], 1))
  // windicators requires degree <= period <= 10000 and deviations in [0, 1000].
  const period = Math.min(10000, countParam(calcParams[1], DEFAULTS[1], degree))
  const dev1 = Math.min(1000, realParam(calcParams[2], DEFAULTS[2], 0))
  const dev2 = Math.min(1000, realParam(calcParams[3], DEFAULTS[3], 0))
  const redraw = countParam(calcParams[4], 1, 0) >= 1
  const dir = countParam(calcParams[5], 1, 0) >= 1 ? -1 : 1
  return { degree, period, dev1, dev2, redraw, dir }
}

export function prcRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Prc[] {
  const { degree, period, dev1, dev2, redraw, dir } = prcSettings(calcParams)
  const lines = polynomialRegressionChannel(bars.map((b) => b.close), degree, period, dev1, dev2, redraw)
  // Redraw off: blank the bands while the window still holds bars Sierra had not drawn (zeros).
  const bandsFrom = redraw ? period : 2 * period
  return lines.middle.map((mid, i) => {
    if (!Number.isFinite(mid)) return {}
    const row: Prc = { middle: mid, state: sideOf(bars[i].close - mid, dir) }
    if (i >= bandsFrom) {
      row.upper1 = lines.upper1[i]
      row.lower1 = lines.lower1[i]
      row.upper2 = lines.upper2[i]
      row.lower2 = lines.lower2[i]
    }
    return row
  })
}

function bandStyle(dashed: boolean) {
  return ({ indicator, defaultStyles }: { indicator: Parameters<typeof signColors>[0]; defaultStyles?: Parameters<typeof signColors>[1] }) =>
    ({ color: signColors(indicator, defaultStyles).flat, ...(dashed ? { style: 'dashed', dashedValue: [4, 3] } : {}) }) as IndicatorFigureStyle
}

const prc: IndicatorTemplate<Prc, number> = {
  name: 'PRC',
  shortName: 'Polynomial Regression Channel',
  series: 'price',
  calcParams: DEFAULTS,
  precision: 5,
  figures: [
    { key: 'upper2', title: 'Upper 2: ', type: 'line', styles: bandStyle(true) },
    { key: 'upper1', title: 'Upper 1: ', type: 'line', styles: bandStyle(false) },
    {
      key: 'middle',
      title: 'Middle: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'lower1', title: 'Lower 1: ', type: 'line', styles: bandStyle(false) },
    { key: 'lower2', title: 'Lower 2: ', type: 'line', styles: bandStyle(true) }
  ],
  calc: (dataList: KLineData[], indicator) => prcRows(dataList, indicator.calcParams)
}

export default prc
