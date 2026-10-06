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

import type { IndicatorFigureStyle, IndicatorTemplate, KLineData } from 'klinecharts'

import { appliedPrice, countParam, realParam } from './mt4'
import { guide, guideColor, signColors } from './paint'

/**
 * BANDPASS -- John Ehlers' band-pass filter (mladen's MT4 "band pass filter"), a sub-pane
 * histogram around zero, in price units.
 *
 * Parameters: [period, delta, price], default [50, 0.1, 4] -- the source's defaults, which are
 * also the best universal setting the NNFX discovery found for it on 1D, as a zero cross (18/28
 * pairs positive). See README.md in this directory.
 *
 * Ehlers' two-pole band-pass centred on `period` bars with relative bandwidth `delta`, applied to
 * MT4 price `price` (0 close, 1 open, 2 high, 3 low, 4 median, 5 typical, 6 weighted):
 *
 *   bp(t) = (1 - a)/2 * (p(t) - p(t-2)) + b (1 + a) bp(t-1) - a bp(t-2)
 *   b = cos(2 pi / period), g = 1 / cos(4 pi delta / period), a = g - sqrt(g^2 - 1)
 *
 * Long while it is above zero, short below. The bars are drawn as the source colours them: up
 * colour above zero, down below, and -- the source's "thickness" -- solid while the filter moves
 * away from zero, hollow while it falls back towards it.
 *
 * Seeded at zero, as Ehlers' original. (mladen seeds with the price, which rings for ~850 bars at
 * period 50 and is otherwise identical.) An IIR filter, so its value depends slightly on where the
 * loaded history starts, decaying over a few periods.
 */

export interface BandPass {
  [key: string]: number | undefined
  bp?: number
  /** +1 above zero, -1 below, held on an exact zero; 0 before the filter has moved. */
  trend?: number
  /** +1 rising, -1 falling, held when flat. */
  slope?: number
}

export interface BandPassOptions {
  period: number
  delta: number
  price: number
}

export function bandPassOptions(calcParams: readonly unknown[]): BandPassOptions {
  return {
    period: countParam(calcParams[0], 50, 2),
    delta: realParam(calcParams[1], 0.1, 0.001),
    price: Math.min(6, countParam(calcParams[2], 4, 0))
  }
}

export function bandPassFilter(bars: readonly KLineData[], options: BandPassOptions): BandPass[] {
  const p = appliedPrice(bars, options.price)
  const n = p.length
  const beta = Math.cos((2 * Math.PI) / options.period)
  const gamma = 1 / Math.cos((4 * Math.PI * options.delta) / options.period)
  const alpha = gamma - Math.sqrt(gamma * gamma - 1)
  const bp = new Array<number>(n).fill(0)
  for (let t = 2; t < n; t++) {
    bp[t] = 0.5 * (1 - alpha) * (p[t] - p[t - 2]) + beta * (1 + alpha) * bp[t - 1] - alpha * bp[t - 2]
  }
  let trend = 0
  let slope = 0
  return bp.map((v, t) => {
    if (t >= 1) {
      if (v > bp[t - 1]) slope = 1
      else if (v < bp[t - 1]) slope = -1
      if (v > 0) trend = 1
      else if (v < 0) trend = -1
    }
    return t < 2 || !Number.isFinite(v) ? { trend, slope } : { bp: v, trend, slope }
  })
}

const bandPass: IndicatorTemplate<BandPass, number> = {
  name: 'BANDPASS',
  shortName: 'Band Pass',
  // Price units: the pane's precision follows the instrument's.
  series: 'price',
  calcParams: [50, 0.1, 4],
  precision: 5,
  figures: [
    {
      key: 'bp',
      title: 'BP: ',
      type: 'bar',
      baseValue: 0,
      styles: ({ data, indicator, defaultStyles }) => {
        const { up, down, flat } = signColors(indicator, defaultStyles)
        const now = data.current?.bp ?? 0
        const before = data.prev?.bp ?? 0
        const color = now > 0 ? up : now < 0 ? down : flat
        // Moving away from zero is the source's thick bar; back towards it, the thin one.
        const away = Math.abs(now) > Math.abs(before)
        return { style: away ? 'fill' : 'stroke', color, borderColor: color } as unknown as IndicatorFigureStyle
      }
    }
  ],
  calc: (dataList: KLineData[], indicator) => bandPassFilter(dataList, bandPassOptions(indicator.calcParams)),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default bandPass
