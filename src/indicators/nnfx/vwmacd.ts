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
import { guide, guideColor, signColors, signLineStyle, withAlpha } from './paint'

/**
 * VWMACD -- Buff Dormeier's volume-weighted MACD in a sub-pane, as pandas-ta-classic's `vwmacd`
 * computes it (windicators `volume_weighted_macd_vwma`, the code the windicators NNFX scan ran):
 * the C2 of the scan's system 2, at fast 9, slow 20, signal 9.
 *
 * Parameters: [fast, slow, signal, sma, inverted], default [9, 20, 9, 0, 1] (the source's own:
 * 12, 26, 9, 0).
 *
 *   VWMA(x, n) = SMA(x x volume, n) / SMA(volume, n)
 *   vwmacd     = VWMA(close, fast) - VWMA(close, slow)
 *   signal     = VWMA(vwmacd, signal), weighted by the bars' volume (sma 0), or SMA(vwmacd, signal)
 *                (sma 1, jesse's version)
 *   hist       = vwmacd - signal
 *
 * Every SMA is pandas' rolling mean: no value until its window holds `n` values. A slow period
 * shorter than the fast one is swapped, as pandas-ta-classic does. The volume is the bars' own
 * (OANDA's tick count).
 *
 * The C2 reading the scan tested is the SIGNAL line against zero with `inverted` 1: it confirms
 * LONG while the signal is BELOW zero and short while above. `inverted` 0 is the conventional
 * reading. The signal line is drawn in the colour of the side it gives.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Vwmacd {
  [key: string]: number | undefined
  vwmacd?: number
  signal?: number
  hist?: number
  state?: number
}

/** pandas' rolling(n).mean(): NaN until the window holds n finite values. */
export function rollingMean(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  for (let i = n - 1; i < x.length; i++) {
    let sum = 0
    let ok = true
    for (let j = i - n + 1; j <= i; j++) {
      if (!Number.isFinite(x[j])) {
        ok = false
        break
      }
      sum += x[j]
    }
    if (ok) out[i] = sum / n
  }
  return out
}

function vwma(price: readonly number[], volume: readonly number[], n: number): number[] {
  const pv = rollingMean(price.map((p, i) => p * volume[i]), n)
  const v = rollingMean(volume, n)
  return pv.map((x, i) => x / v[i])
}

export function vwmacdRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Vwmacd[] {
  let fast = Math.min(100000, countParam(calcParams[0], 9, 1))
  let slow = Math.min(100000, countParam(calcParams[1], 20, 1))
  const signal = Math.min(100000, countParam(calcParams[2], 9, 1))
  const useSma = countParam(calcParams[3], 0, 0) >= 1
  const dir = countParam(calcParams[4], 1, 0) >= 1 ? -1 : 1
  if (slow < fast) [fast, slow] = [slow, fast]
  const close = bars.map((b) => b.close)
  const volume = bars.map((b) => b.volume ?? Number.NaN)
  const fastMa = vwma(close, volume, fast)
  const slowMa = vwma(close, volume, slow)
  const line = fastMa.map((f, i) => f - slowMa[i])
  const sig = useSma ? rollingMean(line, signal) : vwma(line, volume, signal)
  return line.map((l, i) => {
    const row: Vwmacd = { vwmacd: value(l), signal: value(sig[i]), hist: value(l - sig[i]) }
    if (row.signal !== undefined) row.state = dir * Math.sign(row.signal)
    return row
  })
}

const vwmacd: IndicatorTemplate<Vwmacd, number> = {
  name: 'VWMACD',
  shortName: 'VW-MACD',
  calcParams: [9, 20, 9, 0, 1],
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
    { key: 'vwmacd', title: 'VW-MACD: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    {
      key: 'signal',
      title: 'Signal: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => vwmacdRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default vwmacd
