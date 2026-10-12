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

import { countParam, value } from './mt4'
import { rollingMean } from './vwmacd'
import { drawRange, fillBetween, guide, guideColor, signColors, withAlpha } from './paint'

/**
 * MACDEXT -- TA-Lib's MACD with controllable MA type, on simple averages (every MA type SMA), in
 * a sub-pane (windicators `macdext`, the code the windicators NNFX scan ran): the C1 of the scan's
 * system 3 and of its best system overall, at fast 24, slow 26, signal 4. The scan's setting is
 * fastmatype 0 and signalmatype 11, which are both SMA in TA-Lib, so the other MA types are not
 * offered.
 *
 * Parameters: [fast, slow, signal, ma, inverted], default [24, 26, 4, 3, 1] (TA-Lib's own: 12,
 * 26, 9).
 *
 *   macd   = SMA(close, fast) - SMA(close, slow)   (swapped if slow < fast, as TA-Lib does)
 *   signal = SMA(macd, signal)
 *   hist   = macd - signal
 *   ma     = the plain `ma`-bar average of the signal: the scan's trigger
 *
 * As TA-Lib, macd and signal both start at bar max(fast, slow) + signal - 2, where the signal
 * has its first value.
 *
 * The C1 reading the scan tested is the SIGNAL line against its `ma`-bar average with `inverted`
 * 1: LONG while the signal is BELOW its average, short while above. It fades moves: it agreed with
 * the last 10 bars' direction on only 42% of bars. `inverted` 0 is the conventional reading. The
 * area between the two is shaded in the colour of the side it gives.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Macdext {
  [key: string]: number | undefined
  macd?: number
  signal?: number
  hist?: number
  ma?: number
  state?: number
}

export function macdextRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Macdext[] {
  let fast = Math.min(100000, countParam(calcParams[0], 24, 2))
  let slow = Math.min(100000, countParam(calcParams[1], 26, 2))
  const signal = Math.min(100000, countParam(calcParams[2], 4, 1))
  const k = countParam(calcParams[3], 3, 1)
  const dir = countParam(calcParams[4], 1, 0) >= 1 ? -1 : 1
  if (slow < fast) [fast, slow] = [slow, fast]
  const close = bars.map((b) => b.close)
  const fastMa = rollingMean(close, fast)
  const slowMa = rollingMean(close, slow)
  const diff = fastMa.map((f, i) => f - slowMa[i])
  // TA-Lib's MA of period 1 is the line itself.
  const sig = signal > 1 ? rollingMean(diff, signal) : diff.slice()
  const start = Math.max(fast, slow) - 1 + (signal - 1)
  const line = diff.map((d, i) => (i >= start ? d : Number.NaN))
  const ma = rollingMean(sig, k)
  return line.map((l, i) => {
    const row: Macdext = { macd: value(l), signal: value(sig[i]), hist: value(l - sig[i]), ma: value(ma[i]) }
    if (row.signal !== undefined && row.ma !== undefined) row.state = dir * Math.sign(row.signal - row.ma)
    return row
  })
}

const macdext: IndicatorTemplate<Macdext, number> = {
  name: 'MACDEXT',
  shortName: 'MACDEXT',
  calcParams: [24, 26, 4, 3, 1],
  precision: 5,
  figures: [
    {
      key: 'hist',
      title: 'Hist: ',
      type: 'bar',
      baseValue: 0,
      styles: ({ data, indicator, defaultStyles }) => {
        const { up, down, flat } = signColors(indicator, defaultStyles)
        const h = data.current?.hist ?? 0
        const color = withAlpha(h > 0 ? up : h < 0 ? down : flat, 0.45)
        return { style: 'fill', color, borderColor: color } as unknown as IndicatorFigureStyle
      }
    },
    { key: 'macd', title: 'MACD: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    { key: 'signal', title: 'Signal: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => macdextRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const inverted = countParam(indicator.calcParams[4], 1, 0) >= 1
    const [above, below] = inverted ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'signal', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default macdext
