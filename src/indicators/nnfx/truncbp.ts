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
import { drawRange, fillBetween, guide, guideColor, signColors, warmupMark, withAlpha } from './paint'
import { decayBars, poleRadius, sideOf } from './swami'

/**
 * TRUNC_BP -- Ehlers' truncated band-pass filter against the standard band-pass, in a sub-pane
 * (windicators `ehlers_truncated_bandpass`, the code the windicators NNFX scan ran; TruncBP.els,
 * "Truncated Indicators", TASC 2020-07): the scan's #3 1D C1 of round 3 at period 30, bandwidth
 * 0.15, length 11 (+2.31 %/yr per pair, 22 of 28 pairs positive, profit factor 1.18).
 *
 * Parameters: [period, bandwidth, length, inverted, warm-up], default [30, 0.15, 11, 1, 1] (the
 * source's own: 20, 0.1, 10). The scan's bandwidth is 0.15000000000000002 (0.1 x 1.5); 0.15 gives
 * windicators' identical output.
 *
 *   L1 = cos(360 / period deg), G1 = cos(bandwidth 360 / period deg), S1 = 1/G1 - sqrt(1/G1^2 - 1)
 *   bp  = 0.5 (1 - S1)(close - close[2]) + L1 (1 + S1) bp[1] - S1 bp[2], 0 on bars 0-2
 *   bpt = the same recursion re-run on every bar over the last `length` bars only, from zero:
 *         Trunc[length + 2] = Trunc[length + 1] = 0, then for count = length down to 1
 *         Trunc[count] = 0.5 (1 - S1)(close[count - 1] - close[count + 1]) + L1 (1 + S1) Trunc[count + 1]
 *                        - S1 Trunc[count + 2];  bpt = Trunc[1], from bar length + 1
 *
 * So bpt is a function of the last length + 2 closes only (a price shock leaves it after
 * `length` bars), and bp is the ordinary band-pass, with the long memory bpt is meant to avoid.
 * The template leaves bp's three starting zeros blank (Ehlers' "If CurrentBar <= 3 Then BP = 0",
 * the state its recursion starts from), as VOSS leaves jesse's, and the reading with them. On bar
 * length + 2 bpt is bp's own recursion from the same zeros, so the two are equal there (a tie).
 *
 * The C1 reading the scan tested is bpt against bp with `inverted` 1: LONG while the truncated
 * line is BELOW the standard one, short while above; 0 is the conventional reading. The area
 * between the two is shaded in the colour of the side it gives.
 *
 * **Warm-up.** bpt needs none (it is FIR, length + 2 bars), but bp starts from zero rather than
 * from the state a longer history leaves it in, and that start-up error dies away as its pole
 * radius (sqrt(S1), 0.9844 a bar at the defaults) to the power of the bars since. The scan
 * computed it from 2005; a chart computes it from its oldest loaded bar. Measured on the 28 prod
 * pairs' 1D bars from 10,248 start points (2026-10-15), the reading disagreed with the from-2005
 * one on 51% of bars at its first bar, 8.7% 100 bars after the start and 0.8% after 250, and agreed
 * on at least 99.5% of every 25-bar stretch from bar 293 on. Its start-up error being about the
 * size of the line itself, with `warm-up` 1 the template leaves both lines blank until that error
 * is below 1e-2 of its start: 297 bars at the defaults, past which the reading disagreed on 0.016%
 * of the bars measured. The pane says how many bars it needs while it has too few (paint.ts
 * `warmupMark`); 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_r3_cycle.json.
 */

export interface TruncBp {
  [key: string]: number | undefined
  bpt?: number
  bp?: number
  state?: number
}

const DEFAULTS = [30, 0.15, 11, 1, 1]
const DEG = Math.PI / 180

function coefficients(period: number, bandwidth: number): { l1: number; s1: number } {
  const l1 = Math.cos((360 / period) * DEG)
  const g1 = Math.cos(((bandwidth * 360) / period) * DEG)
  return { l1, s1: 1 / g1 - Math.sqrt(1 / (g1 * g1) - 1) }
}

/** windicators' `_trunc_bp`: bpt NaN before bar length + 1; bp 0 on bars 0-2. */
export function truncatedBandPass(close: readonly number[], period: number, bandwidth: number, length: number): { bpt: number[]; bp: number[] } {
  const n = close.length
  const bp = new Array<number>(n).fill(Number.NaN)
  const bpt = new Array<number>(n).fill(Number.NaN)
  const { l1, s1 } = coefficients(period, bandwidth)
  let bp1 = 0
  let bp2 = 0
  const trunc = new Array<number>(length + 3).fill(0)
  for (let t = 0; t < n; t++) {
    const v = t + 1 <= 3 ? 0 : 0.5 * (1 - s1) * (close[t] - close[t - 2]) + l1 * (1 + s1) * bp1 - s1 * bp2
    bp[t] = v
    bp2 = bp1
    bp1 = v
    if (t >= length + 1) {
      trunc[length + 2] = 0
      trunc[length + 1] = 0
      for (let count = length; count >= 1; count--) {
        trunc[count] =
          0.5 * (1 - s1) * (close[t - (count - 1)] - close[t - (count + 1)]) + l1 * (1 + s1) * trunc[count + 1] - s1 * trunc[count + 2]
      }
      bpt[t] = trunc[1]
    }
  }
  return { bpt, bp }
}

/** The first bar the template draws: bpt's first, or bar 3 plus the bars for bp's start-up error to fall below 1e-2. */
export function truncWarmup(period: number, bandwidth: number, length: number): number {
  const { l1, s1 } = coefficients(period, bandwidth)
  return Math.max(length + 1, 3 + decayBars(poleRadius(l1, s1), 1e-2))
}

export function truncSettings(calcParams: readonly unknown[]): { period: number; bandwidth: number; length: number; dir: number; warm: number } {
  const period = Math.min(100000, realParam(calcParams[0], DEFAULTS[0], 2))
  // windicators requires 0 < bandwidth < period / 4 (S1 exists) and 1 <= length <= 98 (Trunc[100]).
  const bandwidth = Math.min(period / 4 - 1e-9, realParam(calcParams[1], DEFAULTS[1], 1e-6))
  const length = Math.min(98, countParam(calcParams[2], DEFAULTS[2], 1))
  const dir = countParam(calcParams[3], 1, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[4], 1, 0) >= 1 ? truncWarmup(period, bandwidth, length) : 0
  return { period, bandwidth, length, dir, warm }
}

export function truncRows(bars: readonly KLineData[], calcParams: readonly unknown[]): TruncBp[] {
  const { period, bandwidth, length, dir, warm } = truncSettings(calcParams)
  const { bpt, bp } = truncatedBandPass(bars.map((b) => b.close), period, bandwidth, length)
  return bars.map((_, i) => {
    if (i < warm) return {}
    const row: TruncBp = { bpt: value(bpt[i]), bp: i >= 3 ? value(bp[i]) : undefined }
    if (row.bpt !== undefined && row.bp !== undefined) row.state = sideOf(row.bpt - row.bp, dir)
    return row
  })
}

const truncBp: IndicatorTemplate<TruncBp, number> = {
  name: 'TRUNC_BP',
  shortName: 'Truncated Band-Pass',
  calcParams: DEFAULTS,
  precision: 6,
  figures: [
    { key: 'bpt', title: 'Truncated: ', type: 'line' },
    { key: 'bp', title: 'BP: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => truncRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const s = truncSettings(indicator.calcParams)
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const [above, below] = s.dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'bpt', 'bp', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart))
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, s.warm)
    return false
  }
}

export default truncBp
