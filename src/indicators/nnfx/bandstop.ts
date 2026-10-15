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
import { signLineStyle, warmupMark } from './paint'
import { decayBars, poleRadius, sideOf } from './swami'

/**
 * BANDSTOP -- Ehlers' band-stop (notch) filter of the close on the price pane, a baseline
 * (windicators `ehlers_band_stop_filter`, the code the windicators NNFX scan ran; the Swiss Army
 * Knife indicator's Type "BS", TASC 2006-01): the band-pass's poles with zeros at `period`, so it
 * removes the cycles near `period` and passes the price elsewhere with unit gain.
 *
 * Parameters: [period, delta, warm-up], default [24, 0.067, 1] (the source's own: 20, 0.1).
 *
 *   beta1 = cos(360 / period deg), gamma1 = 1 / cos(720 delta / period deg),
 *   alpha = gamma1 - sqrt(gamma1^2 - 1), c0 = (1 + alpha) / 2
 *   bs    = c0 (close - 2 beta1 close[1] + close[2]) + beta1 (1 + alpha) bs[1] - alpha bs[2]
 *
 * from bar 2, with bs[1] and bs[2] at 0 (Ehlers' N = 0: no seeding with the price), NaN on bars
 * 0-1. The scan passed the close (Ehlers' own default is the median price).
 *
 * The baseline reading the scan tested: long while the close is above the line, short while
 * below; the line is drawn in the colour of that side. Its two settings (results/windicators-6y/
 * README.md, finding 8, all at delta 0.067):
 *
 *   - period 24 (the default): the baseline of the scan's best system with a real baseline,
 *     band-stop + Trendilo + the polynomial regression middle line inverted (PRC), +2.92 %/yr per
 *     pair, 26 of 28 pairs, the lowest drawdowns of any system (15% worst pair), and of systems 2,
 *     4, 6 and 7 of that table.
 *   - period 30: the best standalone baseline of the scan (+1.79, 23/28, the first baseline there
 *     to beat +1 %/yr), and the baseline of systems 3 (+2.77) and 5 (+2.71).
 *
 * **Warm-up.** The filter starts from zero under a price that is not zero, so its first few
 * hundred bars ring down from 0 towards the price, at the pole radius sqrt(alpha) (0.9826 a bar at
 * 24 / 0.067, 0.9861 at 30) to the power of the bars since. The scan computed it from 2005; a chart
 * computes it from its oldest loaded bar. Measured on the 28 prod pairs' 1D bars from 10,248 start
 * points (2026-10-15), the close's side disagreed with the from-2005 one on about half the bars for
 * the first 300, on 10.8% at bar 400 and 0.1% at 500 (period 24), and agreed on at least 99.5% of
 * every 25-bar stretch from bar 580 on (period 24) and 702 (period 30). The start-up error here is
 * the price level, some 500 times the close's typical distance from the line (0.17% of the price
 * at period 24, the median over the pairs), so with `warm-up` 1 the template leaves the line
 * blank until that error is below 1e-5 of its start, where the band-pass templates stop at 1e-2:
 * 659 bars at period 24 and 823 at 30, past which the side disagreed on 0.005% of the bars
 * measured (at 1e-4, 527 and 659 bars, it still disagreed on 0.8% of some 25-bar stretches). The
 * pane says how many bars it needs while it has too few (paint.ts `warmupMark`). 0 draws from the
 * first bar, where the line starts near 0 and squashes the price pane. (A 1D chart loads 500 bars
 * at a time, so it draws the line once it has scrolled back once.)
 *
 * Locked to windicators by fixtures/wscan_r3_cycle.json.
 */

export interface BandStop {
  [key: string]: number | undefined
  bs?: number
  /** The baseline side: +1 close above the line, -1 below, 0 on it. */
  state?: number
}

const DEFAULTS = [24, 0.067, 1]
const DEG = Math.PI / 180

function coefficients(period: number, delta: number): { beta1: number; alpha: number } {
  const beta1 = Math.cos((360 / period) * DEG)
  const gamma1 = 1 / Math.cos(((720 * delta) / period) * DEG)
  return { beta1, alpha: gamma1 - Math.sqrt(gamma1 * gamma1 - 1) }
}

/** windicators' `_band_stop`, Ehlers' Type "BS" block with b0 = 1, c1 = 0: NaN on bars 0-1. */
export function ehlersBandStop(price: readonly number[], period: number, delta: number): number[] {
  const n = price.length
  const out = new Array<number>(n).fill(Number.NaN)
  const c1 = 0
  const b0 = 1
  const { beta1, alpha } = coefficients(period, delta)
  const c0 = (1 + alpha) / 2
  const b1 = -2 * beta1
  const b2 = 1
  const a1 = beta1 * (1 + alpha)
  const a2 = -alpha
  let filt1 = 0
  let filt2 = 0
  for (let t = 2; t < n; t++) {
    const filt = c0 * (b0 * price[t] + b1 * price[t - 1] + b2 * price[t - 2]) + a1 * filt1 + a2 * filt2 - c1 * price[t]
    out[t] = filt
    filt2 = filt1
    filt1 = filt
  }
  return out
}

/** The first bar the template draws: bar 2, plus the bars for the start-up error to fall below 1e-5. */
export function bandStopWarmup(period: number, delta: number): number {
  const { beta1, alpha } = coefficients(period, delta)
  return 2 + decayBars(poleRadius(beta1, alpha), 1e-5)
}

export function bandStopSettings(calcParams: readonly unknown[]): { period: number; delta: number; warm: number } {
  const period = Math.min(100000, realParam(calcParams[0], DEFAULTS[0], 2))
  // windicators requires 0 < delta < period / 8 (alpha exists).
  const delta = Math.min(period / 8 - 1e-9, realParam(calcParams[1], DEFAULTS[1], 1e-6))
  const warm = countParam(calcParams[2], 1, 0) >= 1 ? bandStopWarmup(period, delta) : 0
  return { period, delta, warm }
}

export function bandStopRows(bars: readonly KLineData[], calcParams: readonly unknown[]): BandStop[] {
  const { period, delta, warm } = bandStopSettings(calcParams)
  const bs = ehlersBandStop(bars.map((b) => b.close), period, delta)
  return bs.map((x, i) => (i < warm || !Number.isFinite(x) ? {} : { bs: x, state: sideOf(bars[i].close - x, 1) }))
}

const bandStop: IndicatorTemplate<BandStop, number> = {
  name: 'BANDSTOP',
  shortName: 'Band-Stop Filter',
  series: 'price',
  calcParams: DEFAULTS,
  precision: 5,
  figures: [
    {
      key: 'bs',
      title: 'BS: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => bandStopRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis }) => {
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, bandStopSettings(indicator.calcParams).warm)
    return false
  }
}

export default bandStop
