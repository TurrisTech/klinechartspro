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
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, warmupMark, withAlpha } from './paint'
import { npSum as pairwiseSum, vsMean, windowMean } from './pdwindow'

// numpy's pairwise sum and the scan's `vs_sma` reading, shared with the other templates (pdwindow.ts).
export { pairwiseSum, vsMean }

/**
 * SWAMI_SWING -- one line of Ehlers and Way's SwamiCharts swing wave in a sub-pane (windicators
 * `ehlers_swami_swing_wave`, the code the windicators NNFX scan ran; "Setting Strategies With
 * SwamiCharts", TASC 2012-04). The indicator is a heat map: Ehlers' two-pole band-pass of the
 * median price tuned to every cycle period 8 .. 48, one line per period (bp8 .. bp48). The
 * template draws the line of one period and its own average.
 *
 * Parameters: [period, delta, ma, inverted, warm-up], default [33, 0.1, 8, 0, 1] (the source's
 * own delta: 0.1; its periods: all of 8 .. 48).
 *
 *   price = (high + low) / 2
 *   beta  = cos(360 / period deg), gamma = 1 / cos(720 delta / period deg), alpha = gamma - sqrt(gamma^2 - 1)
 *   bp    = 0.5 (1 - alpha)(price - price[2]) + beta (1 + alpha) bp[1] - alpha bp[2]
 *
 * from bar 2, with bp[1] and bp[2] at 0 (NaN on bars 0-1, left blank). `period` picks the line
 * (an integer 8 .. 48, windicators' outputs); `delta` is the relative half-bandwidth.
 *
 * The readings the scan tested (results/windicators-6y/README.md):
 *
 *   - the 33-bar line against its own 8-bar mean, at delta 0.1 (the defaults): the scan's #2 1D
 *     C1 of round 3, +2.35 %/yr per pair, 22 of 28 pairs positive. Long while the line is above
 *     its mean (`ma` 8, `inverted` 0).
 *   - the 36-bar line against ZERO, inverted, at delta 0.067: the C2 of the scan's best system
 *     overall (HWC % + this + the VP_POC exit, +3.75, 28/28; +3.46 without the exit) and of the
 *     fifth real-baseline system (band-stop 30 + HWC % + this, +2.71, 26/28). Long while the line is
 *     BELOW zero. Set [36, 0.067, 0, 1].
 *
 * `ma` >= 2 reads the line against its `ma`-bar mean, as the scan's form did (nnfx/forms.py
 * `vs_sma`): the line's distance from each value of the window, averaged in numpy's summation
 * order, so a line that has held one value for `ma` bars reads exactly 0 (no side). The mean is
 * drawn and the area between the two shaded in the colour of the side it gives. `ma` 0 (or 1)
 * reads the line against zero; it is then drawn in the colour of its side. `inverted` 1 swaps long
 * and short. The heat map itself (all 41 lines) is not drawn.
 *
 * **Warm-up.** Each line starts from zero rather than from the state a longer history leaves it
 * in, and that start-up error dies away as the filter's pole radius (sqrt(alpha), 0.9811 a bar at
 * 33 / 0.1) to the power of the bars since. The scan computed it from 2005; a chart computes it
 * from its oldest loaded bar. Measured on the 28 prod pairs' 1D bars from 10,248 start points
 * (2026-10-15): the 33 / 0.1 reading against its 8-bar mean disagreed with the from-2005 one on
 * 23% of bars 25 bars after the start, 0.8% after 200 and 0.3% after 250, and agreed on at least
 * 99.5% of every 25-bar stretch from bar 238 on; the 36 / 0.067 zero reading disagreed on 10% at
 * bar 100, 1.9% at 250, and agreed on 99.5% from bar 381. Its start-up error being about the size
 * of the line itself, the template leaves the line blank until that error is below 1e-2 of its
 * start: 244 bars at 33 / 0.1 and 396 at 36 / 0.067, past which the reading disagreed on 0.011% and
 * 0.020% of the bars measured. The pane says how many bars it needs while it has too few
 * (paint.ts `warmupMark`); `warm-up` 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_r3_cycle.json.
 */

export interface SwamiSwing {
  [key: string]: number | undefined
  bp?: number
  ma?: number
  state?: number
}

const DEFAULTS = [33, 0.1, 8, 0, 1]
const DEG = Math.PI / 180

/** The poles' coefficients: beta (1 + alpha) and alpha, as windicators' `_kernels/ehlers_emd.bandpass` computes them. */
function coefficients(period: number, delta: number): { beta: number; alpha: number } {
  const beta = Math.cos((360 / period) * DEG)
  const gamma = 1 / Math.cos(((720 * delta) / period) * DEG)
  return { beta, alpha: gamma - Math.sqrt(gamma * gamma - 1) }
}

/** Ehlers' band-pass of `price` (windicators `_kernels/ehlers_emd.bandpass`): NaN on bars 0-1. */
export function ehlersBandPass(price: readonly number[], period: number, delta: number): number[] {
  const n = price.length
  const out = new Array<number>(n).fill(Number.NaN)
  const { beta, alpha } = coefficients(period, delta)
  let bp1 = 0
  let bp2 = 0
  for (let t = 2; t < n; t++) {
    const bp = 0.5 * (1 - alpha) * (price[t] - price[t - 2]) + beta * (1 + alpha) * bp1 - alpha * bp2
    out[t] = bp
    bp2 = bp1
    bp1 = bp
  }
  return out
}

/**
 * The radius of the slower pole of z^2 - beta (1 + alpha) z + alpha, the recursion every Ehlers
 * two-pole filter here shares (band-pass, band-stop): its start-up error decays by this a bar.
 */
export function poleRadius(beta: number, alpha: number): number {
  const b = beta * (1 + alpha)
  const disc = b * b - 4 * alpha
  return disc < 0 ? Math.sqrt(alpha) : (Math.abs(b) + Math.sqrt(disc)) / 2
}

/** The bars for a start-up error decaying by `radius` a bar to fall below `eps` of where it started. */
export function decayBars(radius: number, eps: number): number {
  if (!(radius >= 0) || radius >= 1) return 100000
  if (radius === 0) return 0
  return Math.ceil(Math.log(eps) / Math.log(radius))
}

/** The first bar the template draws: bar 2, plus the bars for the start-up error to fall below 1e-2. */
export function swamiWarmup(period: number, delta: number): number {
  const { beta, alpha } = coefficients(period, delta)
  return 2 + decayBars(poleRadius(beta, alpha), 1e-2)
}

/** +1 / -1 / 0 for the sign of `d` after `dir`, never -0. */
export function sideOf(d: number, dir: number): number {
  const s = Math.sign(d)
  return s === 0 ? 0 : dir * s
}

export function swamiSettings(calcParams: readonly unknown[]): { period: number; delta: number; ma: number; dir: number; warm: number } {
  const period = Math.min(48, countParam(calcParams[0], DEFAULTS[0], 8))
  // windicators requires 0 < delta < 1.
  const delta = Math.min(0.999999, realParam(calcParams[1], DEFAULTS[1], 1e-6))
  const k = Math.min(100000, countParam(calcParams[2], DEFAULTS[2], 0))
  const dir = countParam(calcParams[3], 0, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[4], 1, 0) >= 1 ? swamiWarmup(period, delta) : 0
  return { period, delta, ma: k >= 2 ? k : 0, dir, warm }
}

export function swamiRows(bars: readonly KLineData[], calcParams: readonly unknown[]): SwamiSwing[] {
  const { period, delta, ma, dir, warm } = swamiSettings(calcParams)
  const bp = ehlersBandPass(bars.map((b) => (b.high + b.low) / 2), period, delta)
  const mean = ma > 0 ? windowMean(bp, ma) : null
  const d = ma > 0 ? vsMean(bp, ma) : bp
  return bp.map((x, i) => {
    if (i < warm || !Number.isFinite(x)) return {}
    const row: SwamiSwing = { bp: x }
    if (mean !== null) row.ma = value(mean[i])
    if (Number.isFinite(d[i])) row.state = sideOf(d[i], dir)
    return row
  })
}

const swamiSwing: IndicatorTemplate<SwamiSwing, number> = {
  name: 'SWAMI_SWING',
  shortName: 'Swami Swing Wave',
  calcParams: DEFAULTS,
  precision: 6,
  figures: [
    {
      key: 'bp',
      title: 'BP: ',
      type: 'line',
      // Against zero the line carries the side; against its mean the shading does.
      styles: ({ data, indicator, defaultStyles }) =>
        swamiSettings(indicator.calcParams).ma === 0 ? { ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 } : null
    },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => swamiRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const s = swamiSettings(indicator.calcParams)
    if (s.ma > 0) {
      const { up, down } = signColors(indicator, chart.getStyles().indicator)
      const [above, below] = s.dir < 0 ? [down, up] : [up, down]
      fillBetween(ctx, xAxis, yAxis, indicator.result, 'bp', 'ma', drawRange(chart, indicator.result.length),
        withAlpha(above, 0.22), withAlpha(below, 0.22))
    }
    guide(ctx, bounding, yAxis, 0, guideColor(chart), s.ma > 0)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, s.warm)
    return false
  }
}

export default swamiSwing
