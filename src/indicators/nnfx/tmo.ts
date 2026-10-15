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
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, withAlpha } from './paint'
import { ewmMean, npSum, stateOf } from './pdwindow'

/**
 * TMO -- the True Momentum Oscillator (ThinkOrSwim's, by Mobius) in a sub-pane, as pandas-ta
 * 0.4.71b0's `tmo` computes it (windicators `true_momentum_oscillator`,
 * `src/windicators/momentum/true_momentum_oscillator.py`, the code the windicators NNFX scan ran):
 * the scan's #19 1D C1 (+1.88 %/yr per pair, 22/28 pairs positive), at calc length 4 on simple
 * averages, read inverted.
 *
 * Parameters: [length, calc length, smooth length, exclusive, MA mode, inverted], default
 * [14, 4, 3, 1, 0, 1] (pandas-ta's own: 14, 5, 3, exclusive, EMA).
 *
 *   count  = the sum of sign(close - open[k]) over the previous `length` opens (k = 1 .. length; with
 *            `exclusive` 0, pandas-ta's "inclusive" window, k = 1 .. length - 1), NaN on the first
 *            bars, a NaN difference counting 0
 *   tmo    = MA(MA(count, calc length), smooth length)
 *   signal = MA(tmo, smooth length)
 *   tmo momentum, signal momentum = each line minus itself `length` bars earlier
 *
 * MA mode is pandas-ta's average for all three: 0 SMA (a plain window mean, NaN while the window
 * holds a NaN), 1 EMA (seeded with the NaN-skipping mean of the first `length` values, so after a run
 * of leading NaNs at least that long it starts at the first value), 2 RMA (alpha 1 / length, from
 * the first value), each exactly as pandas-ta's own code computes it.
 *
 * The C1 reading the scan tested is TMO against the SIGNAL'S MOMENTUM with `inverted` 1: LONG while
 * TMO is BELOW the signal's momentum, short while above. `inverted` 0 is the conventional reading.
 * TMO is drawn in the colour of the side it gives and the area between the two shaded the same way;
 * the signal and TMO's momentum are context.
 *
 * No warm-up: at the scan's SMA every value is a window over a fixed number of past bars (the
 * signal's momentum first exists on bar 2 x length + calc length + 2 x smooth length - 3, 35 at the
 * scan's setting), so from the first bar it draws it equals the one computed from 2005 (measured,
 * 2026-10-15: 0 of 5.2 million states differ, 28 prod pairs' 1D bars, 6,776 start points). EMA and RMA are recursive and drawn from the first bar, as pandas-ta does; at the scan's
 * lengths the state agreed with the from-2005 one on at least 99.5% of bars from bar 38 (EMA) and
 * 48 (RMA) on, against 28 where it first exists.
 *
 * Locked to windicators by fixtures/wscan_r3_momentum.json.
 */

export interface Tmo {
  [key: string]: number | undefined
  tmo?: number
  signal?: number
  tmo_momentum?: number
  signal_momentum?: number
  state?: number
}

// pandas-ta 0.4.71b0's own averages (windicators `_kernels/pandas_ta_ma.py`).

/** `pandas_ta.sma`: each window summed oldest first as w x value, w = 1 / n; NaN while it holds a NaN. */
function ptaSma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  if (x.length < n) return out
  const w = 1 / n
  for (let t = n - 1; t < x.length; t++) {
    let s = 0
    for (let k = t - n + 1; k <= t; k++) s += w * x[k]
    out[t] = s
  }
  return out
}

/** `Series.iloc[0:n].mean()`: NaN skipped (as 0 in numpy's pairwise sum), NaN when all are. */
function nanmeanHead(x: readonly number[], n: number): number {
  const k = Math.min(n, x.length)
  const tmp = new Array<number>(k).fill(0)
  let count = 0
  for (let i = 0; i < k; i++) {
    if (!Number.isNaN(x[i])) {
      tmp[i] = x[i]
      count++
    }
  }
  return count === 0 ? Number.NaN : npSum(tmp, 0, k) / count
}

/** `pandas_ta.ema`: the first n values replaced by their NaN-skipping mean, then `ewm(span=n, adjust=False)`. */
function ptaEma(x: readonly number[], n: number): number[] {
  if (x.length < n) return new Array<number>(x.length).fill(Number.NaN)
  const y = x.slice()
  const seed = nanmeanHead(x, n)
  for (let i = 0; i < n - 1; i++) y[i] = Number.NaN
  y[n - 1] = seed
  return ewmMean(y, (n - 1) / 2)
}

/** `pandas_ta.rma`: `ewm(alpha=1/n, adjust=False)` from the first non-NaN value. */
function ptaRma(x: readonly number[], n: number): number[] {
  if (x.length < n) return new Array<number>(x.length).fill(Number.NaN)
  const a = 1 / n
  return ewmMean(x, (1 - a) / a)
}

export const TMO_MAMODES = ['SMA', 'EMA', 'RMA'] as const

export function ptaMa(x: readonly number[], n: number, mode: number): number[] {
  return mode === 0 ? ptaSma(x, n) : mode === 1 ? ptaEma(x, n) : ptaRma(x, n)
}

export interface TmoOptions {
  length: number
  calc: number
  smooth: number
  exclusive: boolean
  mamode: number
}

/** The four outputs, exactly as windicators `true_momentum_oscillator`. */
export function trueMomentumOscillator(
  open: readonly number[],
  close: readonly number[],
  o: TmoOptions
): { tmo: number[]; signal: number[]; tmo_momentum: number[]; signal_momentum: number[] } {
  const window = o.exclusive ? o.length : o.length - 1
  const n = close.length
  const count = new Array<number>(n).fill(Number.NaN)
  for (let t = window; t < n; t++) {
    let s = 0
    for (let k = 1; k <= window; k++) {
      const d = close[t] - open[t - k]
      if (d > 0) s += 1
      else if (d < 0) s -= 1
    }
    count[t] = s
  }
  const tmo = ptaMa(ptaMa(count, o.calc, o.mamode), o.smooth, o.mamode)
  const signal = ptaMa(tmo, o.smooth, o.mamode)
  const momentum = (x: number[]) => x.map((v, t) => (t >= o.length ? v - x[t - o.length] : Number.NaN))
  return { tmo, signal, tmo_momentum: momentum(tmo), signal_momentum: momentum(signal) }
}

const DEFAULTS = [14, 4, 3, 1, 0, 1]

export function tmoSettings(calcParams: readonly unknown[]): TmoOptions & { dir: number } {
  const exclusive = countParam(calcParams[3], DEFAULTS[3], 0) >= 1
  // pandas-ta's inclusive window needs two opens to leave one out.
  const length = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], exclusive ? 1 : 2))
  const calc = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const smooth = Math.min(100000, countParam(calcParams[2], DEFAULTS[2], 1))
  const mamode = Math.min(2, countParam(calcParams[4], DEFAULTS[4], 0))
  const dir = countParam(calcParams[5], DEFAULTS[5], 0) >= 1 ? -1 : 1
  return { length, calc, smooth, exclusive, mamode, dir }
}

export function tmoRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Tmo[] {
  const o = tmoSettings(calcParams)
  const r = trueMomentumOscillator(
    bars.map((b) => b.open),
    bars.map((b) => b.close),
    o
  )
  return r.tmo.map((t, i) => {
    const row: Tmo = { tmo: value(t), signal: value(r.signal[i]), tmo_momentum: value(r.tmo_momentum[i]), signal_momentum: value(r.signal_momentum[i]) }
    const s = stateOf(t - r.signal_momentum[i], o.dir)
    if (s !== undefined) row.state = s
    return row
  })
}

const tmo: IndicatorTemplate<Tmo, number> = {
  name: 'TMO',
  shortName: 'True Momentum Oscillator',
  calcParams: DEFAULTS,
  precision: 2,
  figures: [
    { key: 'signal', title: 'Signal: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    {
      key: 'tmo_momentum',
      title: 'TMO mom: ',
      type: 'line',
      styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat, style: 'dashed', dashedValue: [4, 3] })
    },
    { key: 'signal_momentum', title: 'Signal mom: ', type: 'line' },
    {
      key: 'tmo',
      title: 'TMO: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => tmoRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const { dir } = tmoSettings(indicator.calcParams)
    const [above, below] = dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'tmo', 'signal_momentum', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.18), withAlpha(below, 0.18))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default tmo
