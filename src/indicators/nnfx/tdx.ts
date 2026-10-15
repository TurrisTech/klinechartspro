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
import { drawRange, fillBetween, guide, guideColor, signColors, warmupMark, withAlpha } from './paint'
import { ewmMean, infToNan, rollingMean, seedBars, shift, stateOf, vsMean, windowMean } from './pdwindow'

// TongDaXin's primitives as TqSdk 3.10.2 writes them on pandas (`tqsdk/tafunc.py`), and as
// windicators reproduces them (`_kernels/tqsdk_tafunc.py`):
//   SMA(X, N, M) = X.ewm(alpha=M / N, adjust=False).mean()  -- TDX's SMA is an EMA seeded with X's
//                  first value; pandas reaches the alpha through com = (1 - a) / a
//   MA(X, N)     = X.rolling(N).mean()
//   REF(X, N)    = X.shift(N)
// Both window functions see +-inf as NaN (pandas' _prep_values).

/** TDX `SMA(x, n, m)`. */
export function tdxSma(x: readonly number[], n: number, m: number): number[] {
  const a = m / n
  return ewmMean(infToNan(x), (1 - a) / a)
}

/** TDX `MA(x, n)`. */
export function tdxMa(x: readonly number[], n: number): number[] {
  return rollingMean(infToNan(x), n)
}

/** The C1 reading's line against its own k-bar mean (the scan's `ma3`), drawn and read. */
function crossRows<K extends string>(
  lines: Record<K, number[]>,
  read: K,
  k: number,
  dir: number,
  from: number
): Array<Partial<Record<K | 'ma' | 'state', number>>> {
  const x = lines[read]
  const ma = windowMean(x, k)
  const vs = vsMean(x, k)
  const keys = Object.keys(lines) as K[]
  return x.map((_, i) => {
    if (i < from) return {}
    const row: Partial<Record<K | 'ma' | 'state', number>> = {}
    for (const key of keys) row[key] = value(lines[key][i])
    row.ma = value(ma[i])
    row.state = stateOf(vs[i], dir)
    return row
  })
}

// ---------------------------------------------------------------------------- MICD

/**
 * MICD -- TongDaXin's MICD (异同离差动力指数) in a sub-pane, as TqSdk 3.10.2's `ta.MICD` computes
 * it (windicators `micd`, `src/windicators/momentum/micd.py`, the code the windicators NNFX scan
 * ran): the scan's #10 1D C1 (+2.10 %/yr per pair, 19/28 pairs positive), and the C1 of its
 * real-baseline systems 2, 3 and 4 (+2.85, +2.77, +2.75 with the band-stop baseline), at smoothing
 * 4, fast period 15.
 *
 * Parameters: [smoothing, fast period, slow period, ma, inverted, warm-up], default
 * [4, 15, 20, 3, 0, 1] (TqSdk's docstring example, its only defaults: 3, 10, 20).
 *
 *   MI   = C - REF(C, 1)
 *   AMI  = SMA(MI, smoothing, 1)                         TDX's SMA: an EMA, alpha 1 / smoothing,
 *                                                       seeded with MI's first value (bar 1)
 *   DIF  = MA(REF(AMI, 1), fast) - MA(REF(AMI, 1), slow) DIF on bar t reads closes up to t - 1
 *   MICD = SMA(DIF, 10, 1)                               the 10 is TDX's, not a parameter
 *   ma   = the plain `ma`-bar average of MICD: the scan's trigger
 *
 * DIF and MICD start on bar max(fast, slow) + 1, MICD seeded with DIF's first value.
 *
 * The C1 reading the scan tested is MICD against its own 3-bar average, the conventional way round
 * (`inverted` 0): long while MICD is above its average, short while below; exactly level reads no
 * signal. As in the scan, the comparison is the mean of MICD's distance from each of the window's
 * values (`nnfx/forms.py` `vs_sma`), which is MICD minus the average without its rounding residue.
 * The area between MICD and its average is shaded in the colour of the side it gives; DIF is
 * context.
 *
 * **Warm-up.** Both SMAs are EMAs seeded with their first input rather than with the state a longer
 * history would have left them in, and the seed's error dies away as (1 - alpha) a bar: AMI's at
 * 1 - 1 / smoothing from bar 1, MICD's at 0.9 from bar max(fast, slow) + 1. The scan computed it
 * from 2005; a chart computes it from its oldest loaded bar. Measured on the 28 prod pairs' 1D bars
 * from 6,776 start points (every 20th bar, 2026-10-15), at 4 / 15 / 20: the state, first defined on
 * bar 23, disagreed with the from-2005 one on 41% of bars there, 12% at bar 40, 1.8% at bar 60, at
 * most 0.5% from bar 73 on and 0.015% at bar 100. So with `warm-up` 1 the template leaves every line
 * blank until bar max(fast, slow) + 1 plus the bars for the slower seed to fall below 1e-4 of its
 * start (`micdWarmup`): 109 at the defaults (also at TqSdk's 3 / 10 / 20, where the measured 0.5%
 * point is bar 65), past which 6 of 4.7 million bars' states disagreed. The pane says how many bars
 * it needs while it has too few (paint.ts `warmupMark`); 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_r3_momentum.json.
 */

export interface Micd {
  [key: string]: number | undefined
  dif?: number
  micd?: number
  ma?: number
  state?: number
}

const MICD_DEFAULTS = [4, 15, 20, 3, 0, 1]
const MICD_SMOOTHING = 10

/** The first bar MICD draws with `warm-up` 1: its own start, plus the bars for the slower EMA seed to fall below 1e-4. */
export function micdWarmup(smoothing: number, fast: number, slow: number): number {
  return Math.max(fast, slow) + 1 + seedBars(Math.min(1 / smoothing, 1 / MICD_SMOOTHING))
}

export function micdSettings(calcParams: readonly unknown[]): {
  smoothing: number
  fast: number
  slow: number
  k: number
  dir: number
  warm: number
} {
  const smoothing = Math.min(100000, countParam(calcParams[0], MICD_DEFAULTS[0], 1))
  const fast = Math.min(100000, countParam(calcParams[1], MICD_DEFAULTS[1], 1))
  const slow = Math.min(100000, countParam(calcParams[2], MICD_DEFAULTS[2], 1))
  const k = Math.min(100000, countParam(calcParams[3], MICD_DEFAULTS[3], 1))
  const dir = countParam(calcParams[4], MICD_DEFAULTS[4], 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[5], 1, 0) >= 1 ? micdWarmup(smoothing, fast, slow) : 0
  return { smoothing, fast, slow, k, dir, warm }
}

/** TDX MICD's DIF and MICD lines, exactly as windicators `micd`. */
export function micdLines(close: readonly number[], smoothing: number, fast: number, slow: number): { dif: number[]; micd: number[] } {
  const mi = close.map((c, i) => c - (i >= 1 ? close[i - 1] : Number.NaN))
  const lagged = shift(tdxSma(mi, smoothing, 1), 1)
  const fastMa = tdxMa(lagged, fast)
  const slowMa = tdxMa(lagged, slow)
  const dif = fastMa.map((f, i) => f - slowMa[i])
  return { dif, micd: tdxSma(dif, MICD_SMOOTHING, 1) }
}

export function micdRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Micd[] {
  const { smoothing, fast, slow, k, dir, warm } = micdSettings(calcParams)
  const lines = micdLines(
    bars.map((b) => b.close),
    smoothing,
    fast,
    slow
  )
  return crossRows(lines, 'micd', k, dir, warm)
}

const micd: IndicatorTemplate<Micd, number> = {
  name: 'MICD',
  shortName: 'MICD',
  calcParams: MICD_DEFAULTS,
  precision: 6,
  figures: [
    { key: 'dif', title: 'DIF: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    { key: 'micd', title: 'MICD: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => micdRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const { dir, warm } = micdSettings(indicator.calcParams)
    const [above, below] = dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'micd', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, warm)
    return false
  }
}

// ---------------------------------------------------------------------------- RCCD

/**
 * RCCD -- TongDaXin's RCCD (异同离差变化率指数) in a sub-pane, as TqSdk 3.10.2's `ta.RCCD` computes
 * it (windicators `rccd`, `src/windicators/momentum/rccd.py`, the code the windicators NNFX scan
 * ran): the scan's #20 1D C1 (+1.85 %/yr per pair, 19/28 pairs positive), at period 5, slow period
 * 14, read inverted.
 *
 * Parameters: [period, fast period, slow period, ma, inverted, warm-up], default
 * [5, 21, 14, 3, 1, 1] (TqSdk's docstring example, its only defaults: 10, 21, 28). The scan's fast
 * period, 21, is longer than its slow one; nothing requires otherwise (swapping them negates DIF).
 *
 *   RC   = C / REF(C, period)
 *   ARC  = SMA(REF(RC, 1), period, 1)                    TDX's SMA: an EMA, alpha 1 / period,
 *                                                       seeded with its first value (bar period + 1)
 *   DIF  = MA(REF(ARC, 1), fast) - MA(REF(ARC, 1), slow) DIF on bar t reads closes up to t - 2
 *   RCCD = SMA(DIF, period, 1)
 *   ma   = the plain `ma`-bar average of DIF: the scan's trigger
 *
 * DIF and RCCD start on bar period + 1 + max(fast, slow), RCCD seeded with DIF's first value.
 *
 * The C1 reading the scan tested is DIF (not RCCD) against its own 3-bar average with `inverted` 1:
 * LONG while DIF is BELOW its average, short while above; exactly level reads no signal. As in the
 * scan, the comparison is the mean of DIF's distance from each of the window's values
 * (`nnfx/forms.py` `vs_sma`). `inverted` 0 is the conventional reading. The area between DIF and
 * its average is shaded in the colour of the side it gives; RCCD is context.
 *
 * **Warm-up.** ARC and RCCD are EMAs seeded with their first input, and the seed's error dies away
 * as 1 - 1 / period a bar. Measured on the 28 prod pairs' 1D bars from 6,776 start points (every
 * 20th bar, 2026-10-15), at 5 / 21 / 14: the state, first defined on bar 29, disagreed with the
 * from-2005 one on 13.5% of bars there, 1.2% at bar 40, at most 0.5% from bar 44 on and 0.015% at
 * bar 60. So with `warm-up` 1 the template leaves every line blank until bar period + 1 +
 * max(fast, slow) plus the bars for the seed to fall below 1e-4 of its start (`rccdWarmup`): 69 at
 * the defaults (127 at TqSdk's 10 / 21 / 28, where the measured 0.5% point is bar 73), past which 1
 * of 5.0 million bars' states disagreed. 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_r3_momentum.json.
 */

export interface Rccd {
  [key: string]: number | undefined
  dif?: number
  rccd?: number
  ma?: number
  state?: number
}

const RCCD_DEFAULTS = [5, 21, 14, 3, 1, 1]

/** The first bar RCCD draws with `warm-up` 1: its own start, plus the bars for the EMA seed to fall below 1e-4. */
export function rccdWarmup(period: number, fast: number, slow: number): number {
  return period + 1 + Math.max(fast, slow) + seedBars(1 / period)
}

export function rccdSettings(calcParams: readonly unknown[]): {
  period: number
  fast: number
  slow: number
  k: number
  dir: number
  warm: number
} {
  const period = Math.min(100000, countParam(calcParams[0], RCCD_DEFAULTS[0], 1))
  const fast = Math.min(100000, countParam(calcParams[1], RCCD_DEFAULTS[1], 1))
  const slow = Math.min(100000, countParam(calcParams[2], RCCD_DEFAULTS[2], 1))
  const k = Math.min(100000, countParam(calcParams[3], RCCD_DEFAULTS[3], 1))
  const dir = countParam(calcParams[4], RCCD_DEFAULTS[4], 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[5], 1, 0) >= 1 ? rccdWarmup(period, fast, slow) : 0
  return { period, fast, slow, k, dir, warm }
}

/** TDX RCCD's DIF and RCCD lines, exactly as windicators `rccd`. */
export function rccdLines(close: readonly number[], period: number, fast: number, slow: number): { dif: number[]; rccd: number[] } {
  // pandas divides as IEEE does: x / 0 is +-inf (a NaN to the window functions), 0 / 0 NaN.
  const rc = close.map((c, i) => c / (i >= period ? close[i - period] : Number.NaN))
  const lagged = shift(tdxSma(shift(rc, 1), period, 1), 1)
  const fastMa = tdxMa(lagged, fast)
  const slowMa = tdxMa(lagged, slow)
  const dif = fastMa.map((f, i) => f - slowMa[i])
  return { dif, rccd: tdxSma(dif, period, 1) }
}

export function rccdRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Rccd[] {
  const { period, fast, slow, k, dir, warm } = rccdSettings(calcParams)
  const lines = rccdLines(
    bars.map((b) => b.close),
    period,
    fast,
    slow
  )
  return crossRows(lines, 'dif', k, dir, warm)
}

const rccd: IndicatorTemplate<Rccd, number> = {
  name: 'RCCD',
  shortName: 'RCCD',
  calcParams: RCCD_DEFAULTS,
  precision: 6,
  figures: [
    { key: 'dif', title: 'DIF: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' },
    { key: 'rccd', title: 'RCCD: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => rccdRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const { dir, warm } = rccdSettings(indicator.calcParams)
    const [above, below] = dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'dif', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, warm)
    return false
  }
}

export { micd, rccd }
