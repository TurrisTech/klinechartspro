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
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, warmupMark, withAlpha } from './paint'
import { vsMean as distanceFromMean } from './pdwindow'

// The scan's `vs_sma` reading (pdwindow.ts), under the name metro.ts imports it by.
export { distanceFromMean }

/**
 * TRENDILO -- Trendilo in a sub-pane, as the Stonehill library's `Trendilo.mq5` (Gehtsoft, Mario
 * Jemic) computes it (windicators `trendilo`, catalog/momentum/trendilo.toml, the code the
 * windicators NNFX scan ran): the C1 the scan ranked 7th on 1D, and the C1 of its best system with
 * a real baseline (+2.92 %/yr per pair), at smooth 6, length 25, offset 0.5695, sigma 7.
 *
 * Parameters: [smooth, length, offset, sigma, ma, warm-up], default [6, 25, 0.5695, 7, 8, 1] (the
 * source's own: 1, 50, 0.85, 6). Fixed at the scan's setting: the price is the close, the band
 * multiplier 1, and the band's length is `length` (the source's `cblen` false, so the scan's blen 40
 * did nothing).
 *
 *   pch      = 100 x (close - close[smooth bars back]) / close
 *   trendilo = ALMA(pch, length): weights exp(-(i - m)^2 / (2 s^2)), i = 0 the oldest bar,
 *              m = floor(offset x (length - 1)), s = length / sigma
 *   band     = +/- sqrt(mean of trendilo^2 over the last `length` bars)
 *   ma       = trendilo's exact `ma`-bar mean, the scan's trigger
 *
 * windicators leaves trendilo blank for its first length - 1 bars and the band for
 * 2 (length - 1). The C1 reading the scan tested is TRENDILO against its own 8-bar mean, the
 * conventional way round (+2.20 %/yr per pair, 20 of 28 pairs positive): long while it is above
 * its mean, short while below, no signal while it has held one value for 8 bars. The line is drawn
 * in the colour of the side it gives, the area between it and its mean shaded by side, the band in
 * the neutral colour.
 *
 * **Warm-up.** Windowed (FIR), so nothing depends on where the history starts once the windows
 * are inside it; but the source reads the close `smooth` bars before the oldest one as 0, so its
 * first `smooth` changes are +100% and every average reaching them is a spike (at the defaults a
 * median 3.3 times the line's median size on the 28 pairs' 1D bars, enough to squash the pane's
 * scale). Measured on the 28 prod pairs' 1D bars from 4,648 start points (2026-10-15), windicators'
 * reading from a later start (it begins at bar 31) disagreed with the scan's from-2005 one on 30%
 * of bars at 31, 2.6% at 34 and 0.26% at 36, and on none from 37 on. With `warm-up` 1 the template
 * leaves trendilo blank until bar smooth + length - 1 (30 at the defaults) and the band until
 * length - 1 bars after that (54), the first bars none of that reaches; the reading starts ma - 1
 * bars after the line, at 37, and is the from-inception one exactly from there. `warm-up` 0 draws
 * windicators' values from the first bar (paint.ts `warmupMark` marks where the warm-up ends).
 *
 * Locked to windicators by fixtures/wscan_r3_trend.json.
 */

export interface Trendilo {
  [key: string]: number | undefined
  trendilo?: number
  ma?: number
  upper?: number
  lower?: number
  state?: number
}

const DEFAULTS = [6, 25, 0.5695, 7, 8, 1]

export function trendiloSettings(calcParams: readonly unknown[]): {
  smooth: number
  length: number
  offset: number
  sigma: number
  ma: number
  warm: number
} {
  const smooth = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const length = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const offset = realParam(calcParams[2], DEFAULTS[2], 0)
  const sigma = Math.min(100000, countParam(calcParams[3], DEFAULTS[3], 1))
  const ma = Math.min(100000, countParam(calcParams[4], DEFAULTS[4], 1))
  const warm = countParam(calcParams[5], 1, 0) >= 1 ? smooth + length - 1 : 0
  return { smooth, length, offset, sigma, ma, warm }
}

/** windicators' trendilo, upper and lower from the first bar, with the source's 0 before it. */
export function trendiloLines(close: readonly number[], smooth: number, length: number, offset: number, sigma: number): {
  trendilo: number[]
  upper: number[]
  lower: number[]
} {
  const n = close.length
  const at = (t: number) => (t < 0 ? 0 : close[t])
  const pch = close.map((p, t) => (p === 0 ? Number.NaN : ((p - at(t - smooth)) / p) * 100))
  const avpch = new Array<number>(n).fill(Number.NaN)
  const upper = new Array<number>(n).fill(Number.NaN)
  const lower = new Array<number>(n).fill(Number.NaN)
  const m = Math.floor(offset * (length - 1))
  const s = length / sigma
  for (let t = length - 1; t < n; t++) {
    let total = 0
    let wsum = 0
    for (let i = 0; i < length; i++) {
      const w = Math.exp(-((i - m) * (i - m)) / (2 * s * s))
      wsum += w
      total += pch[t - (length - 1 - i)] * w
    }
    if (wsum !== 0) avpch[t] = total / wsum
  }
  // The band over `length` bars, summed newest first as the source's SumOnStream does.
  for (let t = 2 * (length - 1); t < n; t++) {
    let total = 0
    for (let i = 0; i < length; i++) total += avpch[t - i] * avpch[t - i]
    const rms = Math.sqrt(total / length)
    upper[t] = rms
    lower[t] = -rms
  }
  return { trendilo: avpch, upper, lower }
}

export function trendiloRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Trendilo[] {
  const { smooth, length, offset, sigma, ma, warm } = trendiloSettings(calcParams)
  const lines = trendiloLines(
    bars.map((b) => b.close),
    smooth,
    length,
    offset,
    sigma
  )
  const line = lines.trendilo.map((v, t) => (t < warm ? Number.NaN : v))
  const dist = distanceFromMean(line, ma)
  const bandFrom = warm > 0 ? warm + length - 1 : 0
  return line.map((v, t) => {
    const row: Trendilo = {}
    if (Number.isFinite(v)) row.trendilo = v
    if (Number.isFinite(dist[t])) {
      row.ma = v - dist[t]
      row.state = dist[t] === 0 ? 0 : Math.sign(dist[t])
    }
    if (t >= bandFrom && Number.isFinite(lines.upper[t])) {
      row.upper = lines.upper[t]
      row.lower = lines.lower[t]
    }
    return row
  })
}

const trendilo: IndicatorTemplate<Trendilo, number> = {
  name: 'TRENDILO',
  shortName: 'Trendilo',
  calcParams: DEFAULTS,
  precision: 4,
  figures: [
    {
      key: 'trendilo',
      title: 'Trendilo: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'ma', title: 'MA: ', type: 'line' },
    { key: 'upper', title: 'Upper: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    { key: 'lower', title: 'Lower: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => trendiloRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'trendilo', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(up, 0.22), withAlpha(down, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, trendiloSettings(indicator.calcParams).warm)
    return false
  }
}

export default trendilo
