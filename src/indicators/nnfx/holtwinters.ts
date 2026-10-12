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

import { countParam, realParam, sma, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, withAlpha } from './paint'

/**
 * The Holt-Winters moving average and channel, as pandas-ta's `hwma` and `hwc` compute them
 * (windicators `holt_winters_moving_average` / `holt_winters_channel`, the code the windicators
 * NNFX scan ran). Three templates share the recursion:
 *
 *   HWMA     the moving average on the price pane: the baseline of the scan's best 1D systems
 *            with a baseline (systems 1-3; README.md).
 *   HWC      the channel on the price pane: its middle line is system 4's baseline.
 *   HWC_PCT  the price's position in the channel against its own `ma`-bar average, in a
 *            sub-pane: the C1 of systems 1, 2 and 4.
 *
 * Per bar, from the previous bar's level F, velocity V and acceleration A (F starting at the
 * first close, V and A at 0, so there is no warm-up):
 *
 *   F = (1 - na)(F + V + A/2) + na x close
 *   V = (1 - nb)(V + A) + nb (F - F_prev)
 *   A = (1 - nc) A + nc (V - V_prev)
 *   middle = HWMA = F + V + A/2
 *
 * The channel is middle +/- scalar x sqrt(var), var an exponential average (weight nd) of the
 * squared miss (close - middle)^2, read two bars late as pandas-ta does: bar t's band uses the
 * variance up to bar t - 1, which itself adds the miss of bar t - 2. So the band has zero width on
 * the first three bars, where pandas-ta's percent divides by epsilon (~1e13); HWC_PCT leaves those
 * bars blank. percent = (close - lower) / (upper - lower + epsilon): 0 at the lower band, 1 at the
 * upper.
 *
 * Locked to windicators by fixtures/wscan_parity.json. The recursions are IIR, so a value depends
 * a little on where the loaded history starts; at the systems' smoothing (0.3) that fades within a
 * few dozen bars.
 */

export interface HoltWinters {
  middle: number[]
  upper: number[]
  lower: number[]
  width: number[]
  percent: number[]
}

/** A smoothing weight in (0, `max`]: 1 is allowed by the channel, not by the moving average. */
function weight(v: unknown, fallback: number, max: number): number {
  return Math.min(max, realParam(v, fallback, 1e-6))
}

export function holtWinters(close: readonly number[], scalar: number, na: number, nb: number, nc: number, nd: number): HoltWinters {
  const m = close.length
  const out: HoltWinters = {
    middle: new Array<number>(m).fill(Number.NaN),
    upper: new Array<number>(m).fill(Number.NaN),
    lower: new Array<number>(m).fill(Number.NaN),
    width: new Array<number>(m).fill(Number.NaN),
    percent: new Array<number>(m).fill(Number.NaN)
  }
  if (m === 0) return out
  let lastA = 0
  let lastV = 0
  let lastVar = 0
  let lastF = close[0]
  let lastPrice = close[0]
  let lastResult = close[0]
  for (let i = 0; i < m; i++) {
    const f = (1 - na) * (lastF + lastV + 0.5 * lastA) + na * close[i]
    const v = (1 - nb) * (lastV + lastA) + nb * (f - lastF)
    const a = (1 - nc) * lastA + nc * (v - lastV)
    const result = f + v + 0.5 * a
    const variance = (1 - nd) * lastVar + nd * (lastPrice - lastResult) * (lastPrice - lastResult)
    const stddev = Math.sqrt(lastVar)
    const upper = result + scalar * stddev
    const lower = result - scalar * stddev
    out.middle[i] = result
    out.upper[i] = upper
    out.lower[i] = lower
    out.width[i] = upper - lower
    out.percent[i] = (close[i] - lower) / (upper - lower + Number.EPSILON)
    lastPrice = close[i]
    lastA = a
    lastF = f
    lastV = v
    lastVar = variance
    lastResult = result
  }
  return out
}

// ---------------------------------------------------------------------------- HWMA

export interface Hwma {
  [key: string]: number | undefined
  hwma?: number
  /** +1 close above the line, -1 below, 0 on it: the baseline side. */
  side?: number
}

export function hwmaOptions(calcParams: readonly unknown[]): { na: number; nb: number; nc: number } {
  // pandas-ta's hwma wants each weight strictly inside (0, 1).
  return {
    na: weight(calcParams[0], 0.3, 0.999999),
    nb: weight(calcParams[1], 0.067, 0.999999),
    nc: weight(calcParams[2], 0.15, 0.999999)
  }
}

export function hwmaRows(bars: readonly KLineData[], o: { na: number; nb: number; nc: number }): Hwma[] {
  // The moving average is the channel's middle line; the band weights do not touch it.
  const hw = holtWinters(bars.map((b) => b.close), 1, o.na, o.nb, o.nc, 0.1)
  return hw.middle.map((m, i) => ({ hwma: value(m), side: Math.sign(bars[i].close - m) }))
}

/**
 * HWMA -- the Holt-Winters moving average on the price pane, coloured by the close's side: the
 * baseline of the scan's systems 1-3 at na 0.3, nb 0.067, nc 0.15.
 *
 * Parameters: [na, nb, nc], default [0.3, 0.067, 0.15] (pandas-ta's own: 0.2, 0.1, 0.1).
 */
const hwma: IndicatorTemplate<Hwma, number> = {
  name: 'HWMA',
  shortName: 'HWMA',
  series: 'price',
  calcParams: [0.3, 0.067, 0.15],
  precision: 5,
  figures: [
    {
      key: 'hwma',
      title: 'HWMA: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.side, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => hwmaRows(dataList, hwmaOptions(indicator.calcParams))
}

// ---------------------------------------------------------------------------- HWC

export interface Hwc {
  [key: string]: number | undefined
  middle?: number
  upper?: number
  lower?: number
  side?: number
}

export interface HwcOptions {
  scalar: number
  na: number
  nb: number
  nc: number
  nd: number
}

export function hwcOptions(calcParams: readonly unknown[], defaults: readonly number[]): HwcOptions {
  return {
    scalar: Math.min(100, realParam(calcParams[0], defaults[0], 1e-6)),
    na: weight(calcParams[1], defaults[1], 1),
    nb: weight(calcParams[2], defaults[2], 1),
    nc: weight(calcParams[3], defaults[3], 1),
    nd: weight(calcParams[4], defaults[4], 1)
  }
}

const HWC_DEFAULTS = [1.5, 0.3, 0.067, 0.1, 0.1]

export function hwcRows(bars: readonly KLineData[], o: HwcOptions): Hwc[] {
  const hw = holtWinters(bars.map((b) => b.close), o.scalar, o.na, o.nb, o.nc, o.nd)
  return hw.middle.map((m, i) => ({
    middle: value(m),
    upper: value(hw.upper[i]),
    lower: value(hw.lower[i]),
    side: Math.sign(bars[i].close - m)
  }))
}

/**
 * HWC -- the Holt-Winters channel on the price pane. The middle line, coloured by the close's
 * side, is the scan's system 4 baseline (scalar 1.5, na 0.3, nb 0.067, nc 0.1, nd 0.1).
 *
 * Parameters: [scalar, na, nb, nc, nd], default [1.5, 0.3, 0.067, 0.1, 0.1] (pandas-ta's own: 1,
 * 0.2, 0.1, 0.1, 0.1).
 */
const hwc: IndicatorTemplate<Hwc, number> = {
  name: 'HWC',
  shortName: 'HW Channel',
  series: 'price',
  calcParams: HWC_DEFAULTS,
  precision: 5,
  figures: [
    { key: 'upper', title: 'Upper: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    {
      key: 'middle',
      title: 'Middle: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.side, indicator, defaultStyles), size: 2 })
    },
    { key: 'lower', title: 'Lower: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => hwcRows(dataList, hwcOptions(indicator.calcParams, HWC_DEFAULTS))
}

// ---------------------------------------------------------------------------- HWC_PCT

export interface HwcPct {
  [key: string]: number | undefined
  percent?: number
  ma?: number
  /** The C1 reading: +1 long, -1 short, after `inverted`. */
  state?: number
}

const HWC_PCT_DEFAULTS = [1.5, 0.3, 0.15, 0.225, 0.175, 8, 1]

export function hwcPctRows(bars: readonly KLineData[], calcParams: readonly unknown[]): HwcPct[] {
  const o = hwcOptions(calcParams, HWC_PCT_DEFAULTS)
  const k = countParam(calcParams[5], 8, 1)
  const dir = countParam(calcParams[6], 1, 0) >= 1 ? -1 : 1
  const hw = holtWinters(bars.map((b) => b.close), o.scalar, o.na, o.nb, o.nc, o.nd)
  // Blank where the channel has no width yet (pandas-ta divides by epsilon there); the average
  // waits for `k` real values after it.
  const pct = hw.percent.map((p, i) => (hw.width[i] > 0 ? p : Number.NaN))
  const ma = sma(pct, k)
  return pct.map((p, i) => {
    const row: HwcPct = { percent: value(p), ma: value(ma[i]) }
    if (row.percent !== undefined && row.ma !== undefined) row.state = dir * Math.sign(row.percent - row.ma)
    return row
  })
}

/**
 * HWC_PCT -- the close's position in the Holt-Winters channel (0 at the lower band, 1 at the
 * upper) and its own `ma`-bar average, in a sub-pane: the C1 of the scan's systems 1, 2 and 4, at
 * scalar 1.5, na 0.3, nb 0.15, nc 0.225, nd 0.175 against its 8-bar average.
 *
 * Parameters: [scalar, na, nb, nc, nd, ma, inverted], default [1.5, 0.3, 0.15, 0.225, 0.175, 8, 1].
 *
 * `inverted` 1 is the reading the scan tested: LONG while the percent line is BELOW its average,
 * short while above. (Which of two lines counts as "first" is arbitrary; the scan tried both and
 * this way round won.) 0 is the conventional reading. The area between the two lines is shaded in
 * the colour of the side it gives.
 */
const hwcPct: IndicatorTemplate<HwcPct, number> = {
  name: 'HWC_PCT',
  shortName: 'HWC %',
  calcParams: HWC_PCT_DEFAULTS,
  precision: 3,
  figures: [
    { key: 'percent', title: '%: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => hwcPctRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const inverted = countParam(indicator.calcParams[6], 1, 0) >= 1
    const [above, below] = inverted ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'percent', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.18), withAlpha(below, 0.18))
    guide(ctx, bounding, yAxis, 0, guideColor(chart))
    guide(ctx, bounding, yAxis, 1, guideColor(chart))
    return false
  }
}

export { hwc, hwcPct, hwma }
