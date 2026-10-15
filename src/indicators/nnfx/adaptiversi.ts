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

import { adaptiveRsi, dominantCycle, roofing, rsiWarmup, side, versusMean } from './ehlersadaptive'
import { countParam, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, warmupMark, withAlpha } from './paint'

/**
 * ADAPT_RSI -- Ehlers' adaptive RSI (Cycle Analytics for Traders, 2013, Code Listing 11-1) in a
 * sub-pane, as thetestspecimen's MQL5 port computes it (windicators `ehlers_adaptive_rsi`, the code
 * the windicators NNFX scan ran, snapshot 0b4dcc0): the scan's 1D C1 #11, at hp_period 36,
 * lp_period 20, +2.09 %/yr per pair, 21/28 pairs positive (in-sample, best-of-grid;
 * results/windicators-6y/README.md, round 3).
 *
 * Parameters: [avg_length, hp_period, lp_period, ma, inverted, warm-up], default
 * [3, 36, 20, 8, 0, 1] (the source's own: 3, 48, 10). Fixed at the scan's value: price 0, the close.
 * The ranges are windicators' (hp_period >= 3, lp_period >= 1), but hp_period and avg_length stop
 * at 200: the periodogram costs about hp_period^2 a bar.
 *
 *   filt  = the SuperSmoother (lp_period) of a two-pole high-pass (hp_period) of the close
 *   cycle = the dominant cycle the autocorrelation periodogram of filt measures each bar
 *           (ehlersadaptive.ts), clamped to lp_period..hp_period and truncated to an integer
 *   CU, CD = the rises and falls of filt over the last cycle / 2 bars (integer division)
 *   rsi   = c1 (CU / (CU + CD) + the previous bar's ratio) / 2 + c2 rsi[1] + c3 rsi[2], the
 *           SuperSmoother's coefficients at lp_period: 0 to 1, a little outside at the turns
 *
 * windicators (as MetaTrader) writes 0 before bar hp_period + 3 (bar hp_period + 2 is 0 because its
 * previous ratio is the warm-up's); the template leaves those bars blank. Where CU + CD is 0 later
 * on (filt flat over the window) it is 0 as in the source.
 *
 * The C1 reading the scan tested is the RSI against its exact 8-bar mean (the mean of its distance
 * from each value in the window, so an RSI held for 8 bars reads 0, no side), the conventional way
 * round (`inverted` 0): long while the RSI is above its mean, short while below. The area between
 * the two is shaded in the colour of the side it gives; guides at the source's 0.3 and 0.7.
 *
 * **Warm-up.** The front end is recursive and adaptive (adaptivebandpass.ts says how), and so is
 * the RSI's SuperSmoother. The scan computed from 2005; a chart computes from its oldest loaded
 * bar. Measured with windicators on the 28 prod pairs' 1D bars (2026-10-15), each computed from
 * 4,396 later start points, against the from-2005 reading: at the defaults it disagreed on 96% of
 * bars at bar 50 (early on the RSI can sit at exactly 0 for a few dozen bars, a tie), 6.1% at 100,
 * 0.5% at 150, 0.1% at 200 and none from 250; on at most 0.5% at every bar from bar 160. Over
 * hp_period 12-100 x lp_period 5-20 that bar grows with hp_period and is below 3 hp_period + 120
 * at every setting measured (lp_period 5 the slowest). So with `warm-up` 1 the template leaves that
 * many bars blank (`rsiWarmup`): 228 at the defaults, from where the reading disagreed on 0.0005%
 * of 5.6 million bars, at most 0.05% at any bar. The pane says how many bars it needs while it has
 * too few (paint.ts `warmupMark`); 0 draws from the first bar.
 *
 * In Chrome, whose cos, sin and exp are V8's rather than glibc's (ehlersadaptive.ts), the same
 * 1,120 chart starts as adaptivebandpass.ts's gave the RSI, its mean and its state bit for bit as
 * under glibc (2026-10-15).
 *
 * Locked to windicators by fixtures/wscan_r3_adaptive.json.
 */

export interface AdaptiveRsiRow {
  [key: string]: number | undefined
  rsi?: number
  ma?: number
  state?: number
}

const DEFAULTS = [3, 36, 20, 8, 0, 1]

export function adaptiveRsiSettings(calcParams: readonly unknown[]): {
  avgLength: number
  hpPeriod: number
  lpPeriod: number
  ma: number
  dir: number
  warm: number
} {
  // windicators' ranges (hp_period >= 3, lp_period >= 1), with hp_period and avg_length capped
  // where the periodogram's per-bar cost (hp_period^2) stays small.
  const avgLength = Math.min(200, countParam(calcParams[0], DEFAULTS[0], 0))
  const hpPeriod = Math.min(200, countParam(calcParams[1], DEFAULTS[1], 3))
  const lpPeriod = Math.min(10000, countParam(calcParams[2], DEFAULTS[2], 1))
  const ma = Math.min(1000, countParam(calcParams[3], DEFAULTS[3], 1))
  const dir = countParam(calcParams[4], 0, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[5], 1, 0) >= 1 ? rsiWarmup(hpPeriod) : 0
  return { avgLength, hpPeriod, lpPeriod, ma, dir, warm }
}

export function adaptiveRsiRows(bars: readonly KLineData[], calcParams: readonly unknown[]): AdaptiveRsiRow[] {
  const s = adaptiveRsiSettings(calcParams)
  const filt = roofing(
    bars.map((b) => b.close),
    s.hpPeriod,
    s.lpPeriod
  )
  const dc = dominantCycle(filt, s.avgLength, s.hpPeriod, s.lpPeriod, true)
  const rsi = adaptiveRsi(filt, dc, s.hpPeriod, s.lpPeriod).map((x, i) => (i >= s.hpPeriod + 3 ? x : Number.NaN))
  const { ma, vs } = versusMean(rsi, s.ma)
  const from = Math.max(s.hpPeriod + 3, s.warm)
  return bars.map((_, i) => {
    if (i < from) return {}
    const row: AdaptiveRsiRow = { rsi: value(rsi[i]), ma: value(ma[i]) }
    if (Number.isFinite(vs[i])) row.state = side(vs[i], s.dir)
    return row
  })
}

const adaptiveRsiTemplate: IndicatorTemplate<AdaptiveRsiRow, number> = {
  name: 'ADAPT_RSI',
  shortName: 'Adaptive RSI',
  calcParams: DEFAULTS,
  precision: 4,
  figures: [
    { key: 'rsi', title: 'RSI: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => adaptiveRsiRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const s = adaptiveRsiSettings(indicator.calcParams)
    const [above, below] = s.dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'rsi', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0.3, guideColor(chart))
    guide(ctx, bounding, yAxis, 0.7, guideColor(chart))
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, s.warm)
    return false
  }
}

export default adaptiveRsiTemplate
