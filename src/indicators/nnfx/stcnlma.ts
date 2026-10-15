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
import { guide, guideColor, signLineStyle, warmupMark } from './paint'

/**
 * STC_NLMA -- the Schaff Trend Cycle on two NonLag moving averages, in a sub-pane, as mladen's
 * `Schaff trend cycle - nlma.mq5` (Stonehill library) computes it (windicators
 * `schaff_trend_cycle_nlma`, catalog/momentum/schaff_trend_cycle_nlma.toml, and
 * `_kernels/mladen.py` `nonlag`, the code the windicators NNFX scan ran): the C1 the scan ranked
 * 8th on 1D, at schaff period 16, slow NonLag MA 28, smoothing 6.6.
 *
 * Parameters: [schaff, fast, slow, smooth, warm-up], default [16, 23, 28, 6.6, 1] (the source's
 * own: 32, 23, 50, 3). The price is the close, as the scan ran it. The scan's smoothing was
 * 6.6000000000000005; 6.6 gives the same alpha to the last bit, so the same output.
 *
 *   macd   = NonLagMA(close, fast) - NonLagMA(close, slow)
 *   k1     = 100 (macd - lowest macd) / (macd range), over the last `schaff` bars
 *   d1     = EMA(k1), alpha = 2 / (1 + smooth), seeded with the first value
 *   k2     = the same stochastic of d1
 *   stc    = EMA(k2), as d1                                       0 .. 100
 *
 * NonLagMA(L) is Igorad's: 5L - 1 cosine-shaped weights damped by 1 / (3 pi t + 1) past t = 0.5,
 * summed over the bars that exist but always divided by the full weight (so its first 5L - 2 bars
 * are scaled down, the source's own start-up), the price itself on bars 0-2 and for L below 5. As
 * in the source, a stochastic window reaching before the oldest bar counts the unwritten buffer's
 * 0 (which changes nothing here: the MACD, both stochastics and both smoothings are exactly 0 on
 * bar 0, so every such window holds a 0 already), and a zero range repeats the previous value.
 * `trend` is the source's colour: +1 where stc rose, -1 where it fell, 0 where unchanged or on the
 * first bar; it is computed but not drawn.
 *
 * The C1 reading the scan tested is STC against its centre, 50, the conventional way round
 * (+2.19 %/yr per pair, 25 of 28 pairs positive): long while stc is above 50, short while below.
 * The line is drawn in the colour of the side it gives, with a guide at 50.
 *
 * **Warm-up.** The NonLag averages are exact from bar 5 max(fast, slow) - 2, when their windows are
 * inside the history; the two EMAs then carry their seed, which fades as (1 - alpha) a bar. The
 * scan computed from 2005; a chart computes from its oldest loaded bar. Measured on the 28 prod
 * pairs' 1D bars from 4,648 start points (2026-10-15), the reading disagreed with the from-2005 one
 * on 49% of bars at its first bar, still 38% at 150 and 0.9% at 175, and below 0.5% at every bar
 * from 177 on. So with `warm-up` 1 the template leaves the line blank until the averages are
 * exact, both stochastic windows have filled after them and each EMA's seed is below 1e-4 of its
 * start: 5 max(fast, slow) - 2 + 2 (schaff - 1) + 2 ceil(ln 1e-4 / ln(1 - alpha)),
 * 230 bars at the defaults. Past it, 0 of 5.9 million bars disagreed; at six other settings
 * (schaff 8 to 32, fast 4 to 40, slow 3 to 50, smooth 2 to 12) none did past its own bound either,
 * which fell 19 to 88 bars after the last bar that disagreed on more than 0.5%. The pane says how
 * many bars it needs while it has too few (paint.ts `warmupMark`); 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_r3_trend.json.
 */

export interface StcNlma {
  [key: string]: number | undefined
  stc?: number
  trend?: number
  state?: number
}

const DEFAULTS = [16, 23, 28, 6.6, 1]

/** The first bar drawn with `warm-up` 1: the NonLag averages exact, then both windows and both EMA seeds below 1e-4. */
export function stcNlmaWarmup(schaff: number, fast: number, slow: number, smooth: number): number {
  const exact = Math.max(0, ...[fast, slow].filter((l) => l >= 5).map((l) => 5 * l - 2))
  const decay = Math.abs(1 - 2 / (1 + smooth))
  const seed = decay === 0 ? 0 : decay >= 1 ? 100000 : Math.ceil(Math.log(1e-4) / Math.log(decay))
  return exact + 2 * (schaff - 1) + 2 * seed
}

export function stcNlmaSettings(calcParams: readonly unknown[]): {
  schaff: number
  fast: number
  slow: number
  smooth: number
  warm: number
} {
  const schaff = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const fast = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const slow = Math.min(100000, countParam(calcParams[2], DEFAULTS[2], 1))
  const smooth = Math.min(100000, realParam(calcParams[3], DEFAULTS[3], 0))
  const warm = countParam(calcParams[4], 1, 0) >= 1 ? stcNlmaWarmup(schaff, fast, slow, smooth) : 0
  return { schaff, fast, slow, smooth, warm }
}

/** mladen's iNonLagMa (windicators `_kernels.mladen.nonlag`, min length 5, from bar 0). */
export function nonLagMa(x: readonly number[], length: number): number[] {
  const n = x.length
  if (length < 5) return x.slice()
  const out = new Array<number>(n).fill(Number.NaN)
  const cycle = 4
  const coeff = 3 * Math.PI
  const phase = Math.trunc(length - 1)
  const nlen = Math.trunc(length * 4) + phase
  const alphas = new Array<number>(nlen)
  let weight = 0
  for (let k = 0; k < nlen; k++) {
    const t = k <= phase - 1 ? k / (phase - 1) : 1 + ((k - phase + 1) * (2 * cycle - 1)) / (cycle * length - 1)
    const beta = Math.cos(Math.PI * t)
    const g = t <= 0.5 ? 1 : 1 / (coeff * t + 1)
    alphas[k] = g * beta
    weight += alphas[k]
  }
  for (let r = 0; r < n; r++) {
    if (r < 3) {
      out[r] = x[r]
      continue
    }
    if (weight > 0) {
      let s = 0
      for (let k = 0; k < nlen && r - k >= 0; k++) s += alphas[k] * x[r - k]
      out[r] = s / weight
    } else out[r] = 0
  }
  return out
}

/** ArrayMinimum / ArrayMaximum over max(i - period + 1, 0) .. that + period - 1; unwritten elements past `i` hold 0. */
function windowRange(x: readonly number[], i: number, period: number): [number, number] {
  const start = Math.max(i - period + 1, 0)
  let lo = x[start]
  let hi = x[start]
  for (let k = start + 1; k <= i; k++) {
    if (x[k] < lo) lo = x[k]
    if (x[k] > hi) hi = x[k]
  }
  if (start + period - 1 > i) {
    if (0 < lo) lo = 0
    if (0 > hi) hi = 0
  }
  return [lo, hi - lo]
}

/** windicators' stc and trend from the first bar. */
export function schaffNlma(close: readonly number[], schaff: number, fast: number, slow: number, smooth: number): { stc: number[]; trend: number[] } {
  const nf = nonLagMa(close, fast)
  const ns = nonLagMa(close, slow)
  const macd = nf.map((f, i) => f - ns[i])
  const n = macd.length
  const alpha = 2 / (1 + smooth)
  const fastk1 = new Array<number>(n).fill(0)
  const fastd1 = new Array<number>(n).fill(0)
  const fastk2 = new Array<number>(n).fill(0)
  const val = new Array<number>(n).fill(0)
  const trend = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    const [lowMacd, highMacd] = windowRange(macd, i, schaff)
    if (highMacd > 0) fastk1[i] = 100 * ((macd[i] - lowMacd) / highMacd)
    else fastk1[i] = i > 0 ? fastk1[i - 1] : 0
    fastd1[i] = i > 0 ? fastd1[i - 1] + alpha * (fastk1[i] - fastd1[i - 1]) : fastk1[i]
    const [lowStoch, highStoch] = windowRange(fastd1, i, schaff)
    if (highStoch > 0) fastk2[i] = 100 * ((fastd1[i] - lowStoch) / highStoch)
    else fastk2[i] = i > 0 ? fastk2[i - 1] : 0
    val[i] = i > 0 ? val[i - 1] + alpha * (fastk2[i] - val[i - 1]) : fastk2[i]
    if (i > 0) trend[i] = val[i] > val[i - 1] ? 1 : val[i] < val[i - 1] ? -1 : 0
  }
  return { stc: val, trend }
}

export function stcNlmaRows(bars: readonly KLineData[], calcParams: readonly unknown[]): StcNlma[] {
  const { schaff, fast, slow, smooth, warm } = stcNlmaSettings(calcParams)
  const { stc, trend } = schaffNlma(
    bars.map((b) => b.close),
    schaff,
    fast,
    slow,
    smooth
  )
  return stc.map((v, i) => (i < warm || !Number.isFinite(v) ? {} : { stc: v, trend: trend[i], state: v === 50 ? 0 : Math.sign(v - 50) }))
}

const stcNlma: IndicatorTemplate<StcNlma, number> = {
  name: 'STC_NLMA',
  shortName: 'Schaff Trend Cycle (NonLag MA)',
  calcParams: DEFAULTS,
  precision: 2,
  minValue: 0,
  maxValue: 100,
  figures: [
    {
      key: 'stc',
      title: 'STC: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => stcNlmaRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    guide(ctx, bounding, yAxis, 50, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, stcNlmaSettings(indicator.calcParams).warm)
    return false
  }
}

export default stcNlma
