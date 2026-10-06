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

import { countParam, ema, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, withAlpha } from './paint'

/**
 * DODA_STOCH -- the Doda Stochastic (Stonehill's "Doda Stochastic modified", MQL4), a sub-pane
 * oscillator, 0..100.
 *
 * Parameters: [slw, pds, signal], default [12, 20, 14] -- the best universal setting the NNFX
 * discovery found on 1D, as a two-lines cross (18/28 pairs positive; the source's own default is
 * [8, 13, 9]). See README.md in this directory.
 *
 * A stochastic of EMA(close, slw) over its last `pds` values -- (x - lowest) / (highest - lowest)
 * -- smoothed by a second EMA(slw) into the main line, with an EMA(signal) of that as the signal
 * line. Long while the main line is above the signal, short while below: the area between them is
 * shaded in the theme's up / down colour, so a cross is where the shading changes colour.
 *
 * As the source: EMAs are MT4's, seeded with the first close (mt4.ts), so the earliest values
 * depend on where the loaded history starts; the first `pds - 1` bars use the bars there are; a
 * flat window gives 0.
 */

export interface DodaStoch {
  [key: string]: number | undefined
  stoch?: number
  signal?: number
}

export interface DodaOptions {
  slw: number
  pds: number
  signal: number
}

export function dodaOptions(calcParams: readonly unknown[]): DodaOptions {
  return {
    slw: countParam(calcParams[0], 12, 1),
    pds: countParam(calcParams[1], 20, 1),
    signal: countParam(calcParams[2], 14, 1)
  }
}

// The source's ArrayMinimum/ArrayMaximum over the last `pds` values, the window truncated at the
// first bar; 0 when the window is flat.
function rawStochastic(x: readonly number[], pds: number): number[] {
  return x.map((v, t) => {
    if (!Number.isFinite(v)) return Number.NaN
    let lo = v
    let hi = v
    for (let j = Math.max(0, t - pds + 1); j < t; j++) {
      if (x[j] < lo) lo = x[j]
      if (x[j] > hi) hi = x[j]
    }
    return hi - lo !== 0 ? (100 * (v - lo)) / (hi - lo) : 0
  })
}

export function dodaStochastic(bars: readonly KLineData[], options: DodaOptions): DodaStoch[] {
  const smoothed = ema(bars.map((bar) => bar.close), options.slw)
  const main = ema(rawStochastic(smoothed, options.pds), options.slw)
  const signal = ema(main, options.signal)
  return main.map((k, i) => ({ stoch: value(k), signal: value(signal[i]) }))
}

const doda: IndicatorTemplate<DodaStoch, number> = {
  name: 'DODA_STOCH',
  shortName: 'Doda Stoch',
  calcParams: [12, 20, 14],
  precision: 2,
  minValue: 0,
  maxValue: 100,
  figures: [
    { key: 'stoch', title: 'Stoch: ', type: 'line' },
    { key: 'signal', title: 'Signal: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => dodaStochastic(dataList, dodaOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'stoch', 'signal', drawRange(chart, indicator.result.length),
      withAlpha(up, 0.18), withAlpha(down, 0.18))
    guide(ctx, bounding, yAxis, 50, guideColor(chart))
    return false
  }
}

export default doda
