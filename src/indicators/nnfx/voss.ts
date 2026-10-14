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

import { countParam, realParam } from './mt4'
import { guide, guideColor, signColors, signLineStyle, warmupMark } from './paint'

/**
 * VOSS -- Ehlers' Voss predictive filter in a sub-pane, as jesse computes it (windicators
 * `voss_predictive_filter`, the code the windicators NNFX scan ran): the C2 of the scan's sixth
 * baseline system and of its best system overall, at period 36, predict 2, bandwidth 0.1675.
 *
 * Parameters: [period, predict, bandwidth, inverted, warm-up], default [36, 2, 0.1675, 1, 1]
 * (jesse's own: 20, 3, 0.25).
 *
 *   filt = 0.5 (1 - s1) (close - close[2]) + f1 (1 + s1) filt[1] - s1 filt[2]
 *          f1 = cos(2 pi / period), g1 = cos(bandwidth 2 pi / period), s1 = 1/g1 - sqrt(1/g1^2 - 1)
 *   voss = (3 + order) / 2 filt - sum over c < order of (c + 1) / order voss[order - c bars ago],
 *          order = 3 predict
 *
 * jesse holds both at 0 until bar max(period, 5, order) + 1; the template leaves those bars blank.
 *
 * The C2 reading the scan tested is FILT against zero with `inverted` 1: it confirms LONG while
 * the band-pass is BELOW zero and short while above; 0 is the conventional reading. Filt is drawn
 * in the colour of the side it gives; the predictor, voss, is context.
 *
 * **Warm-up.** Filt starts from zero rather than from the state a longer history would have left
 * it in, and that start-up error dies away as the filter's pole radius to the power of the bars
 * since (sqrt(s1), 0.9855 a bar at the defaults). The scan computed it from 2005; a chart computes
 * it from its oldest loaded bar. Measured on the 28 prod pairs' 1D bars from 1,316 start points
 * (2026-10-14), filt's sign disagreed with the from-2005 one on 45% of bars at its first bar, 7% 100
 * bars later and 0.5% after 250. So with `warm-up` 1 the template leaves both lines blank until
 * that error is below 1e-4 of its start: 668 bars at the defaults, past which the sign disagreed on
 * 3 of 1.5 million bars and voss was within 0.12% of its median size. The pane says how many bars
 * it needs while it has too few (paint.ts `warmupMark`); 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Voss {
  [key: string]: number | undefined
  voss?: number
  filt?: number
  state?: number
}

const DEFAULTS = [36, 2, 0.1675, 1, 1]

/** The filter's coefficients, as jesse computes them. */
function coefficients(period: number, bandwidth: number): { f1: number; s1: number } {
  const f1 = Math.cos((2 * Math.PI) / period)
  const g1 = Math.cos((bandwidth * 2 * Math.PI) / period)
  return { f1, s1: 1 / g1 - Math.sqrt(1 / (g1 * g1) - 1) }
}

/** The first bar the template draws: jesse's own start, plus the bars for filt's start-up error to fall below 1e-4. */
export function vossWarmup(period: number, predict: number, bandwidth: number): number {
  const start = Math.max(period, 5, 3 * predict) + 1
  const { f1, s1 } = coefficients(period, bandwidth)
  // The slower root of z^2 - f1 (1 + s1) z + s1: a complex pair has radius sqrt(s1).
  const b = f1 * (1 + s1)
  const disc = b * b - 4 * s1
  const radius = disc < 0 ? Math.sqrt(s1) : (Math.abs(b) + Math.sqrt(disc)) / 2
  if (!(radius > 0) || radius >= 1) return Math.max(start, 100000)
  return start + Math.ceil(Math.log(1e-4) / Math.log(radius))
}

export function vossSettings(calcParams: readonly unknown[]): { period: number; predict: number; bandwidth: number; dir: number; warm: number } {
  const period = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const predict = Math.min(10000, countParam(calcParams[1], DEFAULTS[1], 0))
  const bandwidth = Math.min(period / 4 - 1e-9, realParam(calcParams[2], DEFAULTS[2], 1e-6))
  const dir = countParam(calcParams[3], 1, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[4], 1, 0) >= 1 ? vossWarmup(period, predict, bandwidth) : 0
  return { period, predict, bandwidth, dir, warm }
}

export function vossRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Voss[] {
  const { period, predict, bandwidth, dir, warm } = vossSettings(calcParams)
  const n = bars.length
  const order = 3 * predict
  const { f1, s1 } = coefficients(period, bandwidth)
  const start = Math.max(period, 5, order) + 1
  const filt = new Array<number>(n).fill(0)
  const voss = new Array<number>(n).fill(0)
  for (let i = start; i < n; i++) {
    filt[i] = 0.5 * (1 - s1) * (bars[i].close - bars[i - 2].close) + f1 * (1 + s1) * filt[i - 1] - s1 * filt[i - 2]
  }
  for (let i = start; i < n; i++) {
    let sumc = 0
    for (let count = 0; count < order; count++) sumc += ((count + 1) / order) * voss[i - (order - count)]
    voss[i] = ((3 + order) / 2) * filt[i] - sumc
  }
  const from = Math.max(start, warm)
  return bars.map((_, i) => (i < from || !Number.isFinite(filt[i]) ? {} : { voss: voss[i], filt: filt[i], state: dir * Math.sign(filt[i]) }))
}

const voss: IndicatorTemplate<Voss, number> = {
  name: 'VOSS',
  shortName: 'Voss Predictive Filter',
  calcParams: DEFAULTS,
  precision: 6,
  figures: [
    {
      key: 'filt',
      title: 'Filt: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'voss', title: 'Voss: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => vossRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, bounding, indicator, xAxis, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, vossSettings(indicator.calcParams).warm)
    return false
  }
}

export default voss
