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

import { countParam, sma, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, withAlpha } from './paint'
import { emaTalib, rollingExtreme } from './talib'

/**
 * SMI -- William Blau's Stochastic Momentum Index in a sub-pane, as TA-Lib 0.8.1 computes it (the
 * NNFX study's System C C1: SMI 39/6/75/27 against its own 3-bar average).
 *
 * Parameters: [period, fast, slow, signal, ma], default [39, 6, 75, 27, 3].
 *
 * Over the last `period` bars, the close's distance from the middle of the range,
 * close - (highest high + lowest low) / 2, and the range itself, highest - lowest, are each
 * smoothed twice by TA-Lib's EMA (SMA-seeded): first over `slow`, then over `fast`. SMI is
 * 100 x smoothed distance / (0.5 x smoothed range): +100 pins the close to the top of the range.
 * `signal` is TA-Lib's signal line, an EMA of SMI; `ma` is the study's trigger, a plain `ma`-bar
 * average of SMI. Long while SMI is above its average (the area between them is shaded in the up
 * colour), short while below.
 *
 * Locked to TA-Lib by fixtures/library_parity.json. TA-Lib withholds SMI until its signal line
 * exists too; here SMI is drawn from its own first value, `signal` - 1 bars sooner, with the same
 * numbers wherever TA-Lib has one.
 */

export interface Smi {
  [key: string]: number | undefined
  smi?: number
  signal?: number
  ma?: number
}

export interface SmiOptions {
  period: number
  fast: number
  slow: number
  signal: number
  ma: number
}

export function smiOptions(calcParams: readonly unknown[]): SmiOptions {
  return {
    period: countParam(calcParams[0], 39, 1),
    fast: countParam(calcParams[1], 6, 1),
    slow: countParam(calcParams[2], 75, 1),
    signal: countParam(calcParams[3], 27, 1),
    ma: countParam(calcParams[4], 3, 1)
  }
}

export function stochasticMomentumIndex(bars: readonly KLineData[], options: SmiOptions): Smi[] {
  const { period, fast, slow } = options
  const hh = rollingExtreme(bars.map((b) => b.high), period, 'max')
  const ll = rollingExtreme(bars.map((b) => b.low), period, 'min')
  const distance = bars.map((b, i) => b.close - (hh[i] + ll[i]) / 2)
  const range = hh.map((h, i) => h - ll[i])
  const num = emaTalib(emaTalib(distance, slow), fast)
  const den = emaTalib(emaTalib(range, slow), fast)
  const smi = num.map((n, i) => (100 * n) / (0.5 * den[i]))
  const signal = emaTalib(smi, options.signal)
  const ma = sma(smi, options.ma)
  return smi.map((s, i) => ({ smi: value(s), signal: value(signal[i]), ma: value(ma[i]) }))
}

const smi: IndicatorTemplate<Smi, number> = {
  name: 'SMI',
  shortName: 'SMI',
  calcParams: [39, 6, 75, 27, 3],
  precision: 2,
  figures: [
    { key: 'smi', title: 'SMI: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' },
    { key: 'signal', title: 'Signal: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => stochasticMomentumIndex(dataList, smiOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'smi', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(up, 0.18), withAlpha(down, 0.18))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default smi
