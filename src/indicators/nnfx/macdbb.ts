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
import { stateOf, vsMean, windowMean } from './pdwindow'

/**
 * MACD_BB -- Sierra Chart's MACD Bollinger Bands - Improved in a sub-pane (windicators
 * `macd_bollinger_bands`, `src/windicators/momentum/macd_bollinger_bands.py`, a translation of
 * `scsf_MACDBollingerBandsImproved`, Studies5.cpp, build 2784; the code the windicators NNFX scan
 * ran): the scan's #12 1D C1 (+2.06 %/yr per pair, 22/28 pairs positive), at slow length 20, MACD
 * length 7, two standard deviations, the skip-zeros simple average.
 *
 * Parameters: [fast, slow, macd length, deviations, MA type, ma, inverted], default
 * [12, 20, 7, 2, 5, 3, 0] (Sierra's own: 12, 26, 9, 1, SIMPLE).
 *
 *   macd   = MA(close, fast) - MA(close, slow)
 *   signal = MA(macd, macd length), and hist = macd - signal, both 0 before bar
 *            max(fast, slow) + macd length
 *   upper  = signal + MA(|hist|, macd length) + deviations x SD(|hist|, macd length)
 *   lower  = signal - MA(|hist|, macd length) - deviations x SD(|hist|, macd length)
 *   ma     = the plain `ma`-bar average of upper: the scan's trigger
 *
 * Every MA is of the one Sierra type: 0 EXPONENTIAL, 2 SIMPLE, 3 WEIGHTED, 4 WILDERS, 5 SIMPLE SKIP
 * ZEROS (the mean of the window's non-zero values), 6 SMOOTHED, each exactly as Sierra's
 * `MovingAverage_S` computes it bar by bar (partial windows early on, the EMA's length growing with
 * the bars and re-seeding from the previous input when its previous value is exactly 0); any other
 * value is SIMPLE, as in `MovingAverage_S` (1, LINEARREGRESSION, is not offered: windicators leaves it
 * out because its window reads ahead). SD is Sierra's population deviation, sqrt(E[x^2] - E[x]^2).
 * Sierra computes in float32 and windicators in float64; the template is windicators. As Sierra
 * draws nothing before bar 2 x macd length + max(fast, slow), the template leaves those bars blank.
 *
 * The C1 reading the scan tested is the UPPER band against its own 3-bar average, the conventional
 * way round (`inverted` 0): long while the band is above its average, short while below; exactly
 * level reads no signal. As in the scan, the comparison is the mean of the band's distance from each
 * of the window's values (`nnfx/forms.py` `vs_sma`). The area between the band and its average is
 * shaded in the colour of the side it gives; the MACD line, the signal and the lower band are
 * context.
 *
 * No warm-up: at the scan's type (5), and at SIMPLE and WEIGHTED, every value is a window over the
 * last 2 x macd length + max(fast, slow) bars, so from the first bar it draws it equals the one
 * computed from 2005 (measured, 2026-10-15: 0 of 5.2 million states differ, 28 prod pairs' 1D bars,
 * 6,776 start points). EXPONENTIAL, WILDERS and SMOOTHED are recursive and drawn from the first bar,
 * as Sierra draws them; at the scan's lengths with EXPONENTIAL the state agreed with the from-2005
 * one on at least 99.5% of bars from bar 68 on.
 *
 * Locked to windicators by fixtures/wscan_r3_momentum.json.
 */

export interface MacdBb {
  [key: string]: number | undefined
  macd?: number
  signal?: number
  upper?: number
  lower?: number
  ma?: number
  state?: number
}

// scconstants.h's MOVAVGTYPE_* enum.
export const SIERRA_EXPONENTIAL = 0
export const SIERRA_SIMPLE = 2
export const SIERRA_WEIGHTED = 3
export const SIERRA_WILDERS = 4
export const SIERRA_SIMPLE_SKIP_ZEROS = 5
export const SIERRA_SMOOTHED = 6
const MA_TYPES = [SIERRA_EXPONENTIAL, SIERRA_SIMPLE, SIERRA_WEIGHTED, SIERRA_WILDERS, SIERRA_SIMPLE_SKIP_ZEROS, SIERRA_SMOOTHED]
const FLT_MAX = 3.4028234663852886e38

// Sierra Chart's sc.MovingAverage helpers (SCStudyFunctions.cpp, windicators `_kernels/sierra_movavg.py`):
// each is called once per bar, oldest first, and writes out[index] (the EMA and Wilders may also
// rewrite out[index - 1] while it is 0). The arrays start at 0, as a study's do on a full
// recalculation, and a read outside the array is clamped into it, as SCFloatArray's operator[].

function at(a: ArrayLike<number>, i: number): number {
  return a[i < 0 ? 0 : i >= a.length ? a.length - 1 : i]
}

function simple(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  if (length < 1) return
  let s = 0
  const len = index < length - 1 ? index + 1 : length
  if (index >= inp.length || index < 0) return
  for (let k = index - len + 1; k <= index; k++) s = s + inp[k]
  out[index] = s / len
}

function exponential(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  if (index >= inp.length) return
  if (index < 1 || length < 1) return
  const len = index < length - 1 ? index + 1 : length
  const m1 = 2 / (len + 1)
  const m2 = 1 - m1
  const prev = out[index - 1]
  if (prev === 0 || !(prev > -FLT_MAX && prev < FLT_MAX)) out[index - 1] = at(inp, index - 1)
  out[index] = m1 * at(inp, index) + m2 * out[index - 1]
}

function weighted(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  if (length < 1) return
  const len = index < length - 1 ? index + 1 : length
  if (index >= inp.length || index < 0) return
  let s = 0
  const divider = (len * (len + 1)) / 2
  let w = len
  for (let k = index; k > index - len; k--) {
    s += inp[k] * w
    w -= 1
  }
  out[index] = s / divider
}

function simpleSkipZeros(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  let count = 0
  let s = 0
  const len = length > index + 1 ? index + 1 : length
  for (let k = index - len + 1; k <= index; k++) {
    const v = at(inp, k)
    if (v !== 0) {
      s += v
      count += 1
    }
  }
  out[index] = count > 0 ? s / count : 0
}

function wilders(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  if (index < 1) return
  if (out[index - 1] === 0) simpleSkipZeros(inp, out, index - 1, length)
  if (out[index - 1] !== 0) out[index] = out[index - 1] + (1 / length) * (at(inp, index) - out[index - 1])
}

function smoothed(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  if (index < length - 1) out[index] = 0
  else if (index === length - 1) simple(inp, out, length - 1, length)
  else out[index] = (length * out[index - 1] - out[index - 1] + at(inp, index)) / length
}

/** Sierra's `MovingAverage_S`: one bar of the chosen average; an unknown type is SIMPLE. */
export function sierraMovingAverage(inp: Float64Array, out: Float64Array, maType: number, index: number, length: number): void {
  if (maType === SIERRA_EXPONENTIAL) exponential(inp, out, index, length)
  else if (maType === SIERRA_WEIGHTED) weighted(inp, out, index, length)
  else if (maType === SIERRA_WILDERS) wilders(inp, out, index, length)
  else if (maType === SIERRA_SIMPLE_SKIP_ZEROS) simpleSkipZeros(inp, out, index, length)
  else if (maType === SIERRA_SMOOTHED) smoothed(inp, out, index, length)
  else simple(inp, out, index, length)
}

/** Sierra's `GetMovingAverage`: the window ending at `start`, moved to end at length - 1 while it does not fit. */
function movingAverageOfWindow(inp: Float64Array, start: number, length: number): number {
  const st = start < length - 1 ? length - 1 : start
  if (st >= inp.length) return 0
  let s = 0
  for (let k = 0; k < length; k++) s += at(inp, st - k)
  return s / length
}

/** Sierra's `StandardDeviation_S`: sqrt(E[x^2] - E[x]^2), E[x^2] over the bars there are, divided by `length`. */
function standardDeviation(inp: Float64Array, out: Float64Array, index: number, length: number): void {
  let mean1 = 0
  for (let off = 0; off < length; off++) {
    if (index - off < 0) break
    const v = at(inp, index - off)
    mean1 += v * v
  }
  mean1 = mean1 / length
  let mean2 = movingAverageOfWindow(inp, index, length)
  mean2 *= mean2
  const variance = mean1 - mean2
  out[index] = variance < 0 ? 0 : Math.sqrt(variance)
}

export interface MacdBbOptions {
  fast: number
  slow: number
  macdLength: number
  devs: number
  maType: number
}

/** The four outputs, exactly as windicators `macd_bollinger_bands` (NaN before Sierra's DataStartIndex). */
export function macdBollingerBands(real: readonly number[], o: MacdBbOptions): { macd: number[]; signal: number[]; upper: number[]; lower: number[] } {
  const n = real.length
  // TA-Lib framing, as windicators: leading NaNs are skipped and the outputs placed back after them.
  let start = real.findIndex((v) => !Number.isNaN(v))
  if (start < 0) start = Math.max(0, n - 1)
  const x = Float64Array.from(real.slice(start))
  const m = x.length
  const fastMa = new Float64Array(m)
  const slowMa = new Float64Array(m)
  const macd = new Float64Array(m)
  const macdMa = new Float64Array(m)
  const macdDiff = new Float64Array(m)
  const absDiff = new Float64Array(m)
  const maAbsDiff = new Float64Array(m)
  const sdAbsDiff = new Float64Array(m)
  const out = {
    macd: new Array<number>(n).fill(Number.NaN),
    signal: new Array<number>(n).fill(Number.NaN),
    upper: new Array<number>(n).fill(Number.NaN),
    lower: new Array<number>(n).fill(Number.NaN)
  }
  const first = Math.min(2 * o.macdLength + Math.max(o.fast, o.slow), m)
  for (let i = 0; i < m; i++) {
    // sc.MACD (MACD_S): the line, then -- from bar max(fast, slow) + macd length -- its average and the difference.
    sierraMovingAverage(x, fastMa, o.maType, i, o.fast)
    sierraMovingAverage(x, slowMa, o.maType, i, o.slow)
    macd[i] = fastMa[i] - slowMa[i]
    if (i >= Math.max(o.slow, o.fast) + o.macdLength) {
      sierraMovingAverage(macd, macdMa, o.maType, i, o.macdLength)
      macdDiff[i] = macd[i] - macdMa[i]
    }
    const signal = macdMa[i]
    absDiff[i] = Math.abs(macdDiff[i])
    sierraMovingAverage(absDiff, maAbsDiff, o.maType, i, o.macdLength)
    standardDeviation(absDiff, sdAbsDiff, i, o.macdLength)
    // Read on the bar itself: a later bar's EMA may rewrite this bar's average, not what was drawn.
    if (i < first) continue
    out.macd[start + i] = macd[i]
    out.signal[start + i] = signal
    out.upper[start + i] = signal + maAbsDiff[i] + o.devs * sdAbsDiff[i]
    out.lower[start + i] = signal - maAbsDiff[i] - o.devs * sdAbsDiff[i]
  }
  return out
}

const DEFAULTS = [12, 20, 7, 2, 5, 3, 0]

export function macdBbSettings(calcParams: readonly unknown[]): MacdBbOptions & { k: number; dir: number } {
  const fast = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const slow = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const macdLength = Math.min(100000, countParam(calcParams[2], DEFAULTS[2], 1))
  const devs = Math.min(100000, countParam(calcParams[3], DEFAULTS[3], 1))
  const t = countParam(calcParams[4], DEFAULTS[4], 0)
  const maType = MA_TYPES.includes(t) ? t : SIERRA_SIMPLE
  const k = Math.min(100000, countParam(calcParams[5], DEFAULTS[5], 1))
  const dir = countParam(calcParams[6], DEFAULTS[6], 0) >= 1 ? -1 : 1
  return { fast, slow, macdLength, devs, maType, k, dir }
}

export function macdBbRows(bars: readonly KLineData[], calcParams: readonly unknown[]): MacdBb[] {
  const o = macdBbSettings(calcParams)
  const r = macdBollingerBands(
    bars.map((b) => b.close),
    o
  )
  const ma = windowMean(r.upper, o.k)
  const vs = vsMean(r.upper, o.k)
  return r.upper.map((u, i) => {
    const row: MacdBb = { macd: value(r.macd[i]), signal: value(r.signal[i]), upper: value(u), lower: value(r.lower[i]), ma: value(ma[i]) }
    const s = stateOf(vs[i], o.dir)
    if (s !== undefined) row.state = s
    return row
  })
}

const macdBb: IndicatorTemplate<MacdBb, number> = {
  name: 'MACD_BB',
  shortName: 'MACD Bollinger Bands',
  calcParams: DEFAULTS,
  precision: 5,
  figures: [
    { key: 'macd', title: 'MACD: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    {
      key: 'signal',
      title: 'Signal: ',
      type: 'line',
      styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat, style: 'dashed', dashedValue: [4, 3] })
    },
    { key: 'upper', title: 'Upper: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' },
    { key: 'lower', title: 'Lower: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => macdBbRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const { dir } = macdBbSettings(indicator.calcParams)
    const [above, below] = dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'upper', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default macdBb
