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
import { guide, guideColor, signLineStyle } from './paint'
import { MLADEN_PRICE_MAX, mladenPrice } from './prices'

/**
 * CORR_TREND -- John Ehlers' Correlation Trend (TASC May 2020; mladen's version, as the Stonehill
 * library carries it), a sub-pane oscillator, -1..+1.
 *
 * Parameters: [short, long, price], default [40, 80, 15] -- the setting the NNFX discovery ranked
 * best for it on 8h, read as the LONG line's zero cross (16/28 pairs positive; the same setting
 * leads on 1D, where it trades only ~3 times a pair-year). The source's default is [20, 40, 15].
 * See README.md in this directory.
 *
 * Each line is the Pearson correlation of the last N prices with a straight rising line: +1 is a
 * perfect uptrend over the window, -1 a perfect downtrend, 0 no linear trend. The long line is
 * drawn in the up colour above zero and the down colour below, so its zero cross is a colour
 * change; the short line is the theme's first line colour. Whichever period is smaller is the
 * short line, as the source.
 *
 * `price` is mladen's price list, all 33 of it (prices.ts); 15, the Stonehill default, is the
 * Heiken Ashi median. The MQL5 original reads the close only; the MT4 build Stonehill carries adds
 * the list.
 *
 * Checked against mladen's published MQL5 (sources.test.ts): the same sums, y = -k, the shorter
 * period always the short line, 0 when either variance term is not positive. One departure: the
 * source also prints the first period - 1 bars, dividing partial-window sums by the full period;
 * here nothing is drawn until a full window exists.
 */

export interface CorrTrend {
  [key: string]: number | undefined
  short?: number
  long?: number
}

export interface CorrTrendOptions {
  short: number
  long: number
  price: number
}

export function corrTrendOptions(calcParams: readonly unknown[]): CorrTrendOptions {
  const a = countParam(calcParams[0], 40, 2)
  const b = countParam(calcParams[1], 80, 2)
  return { short: Math.min(a, b), long: Math.max(a, b), price: Math.min(MLADEN_PRICE_MAX, countParam(calcParams[2], 15, 0)) }
}

// Pearson correlation of the last `per` values with y = -k for the value k bars back.
function correlation(x: readonly number[], per: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  for (let i = per - 1; i < x.length; i++) {
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    let syy = 0
    for (let k = 0; k < per; k++) {
      const v = x[i - k]
      const y = -k
      sx += v
      sxx += v * v
      sxy += v * y
      sy += y
      syy += y * y
    }
    const t1 = per * sxx - sx * sx
    const t2 = per * syy - sy * sy
    out[i] = t1 > 0 && t2 > 0 ? (per * sxy - sx * sy) / Math.sqrt(t1 * t2) : 0
  }
  return out
}

export function correlationTrend(bars: readonly KLineData[], options: CorrTrendOptions): CorrTrend[] {
  const p = mladenPrice(bars, options.price)
  const short = correlation(p, options.short)
  const long = correlation(p, options.long)
  return short.map((s, i) => ({ short: value(s), long: value(long[i]) }))
}

const corrTrend: IndicatorTemplate<CorrTrend, number> = {
  name: 'CORR_TREND',
  shortName: 'Corr Trend',
  calcParams: [40, 80, 15],
  precision: 3,
  minValue: -1,
  maxValue: 1,
  figures: [
    { key: 'short', title: 'Short: ', type: 'line' },
    {
      key: 'long',
      title: 'Long: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => signLineStyle(Math.sign(data.current?.long ?? 0), indicator, defaultStyles)
    }
  ],
  calc: (dataList: KLineData[], indicator) => correlationTrend(dataList, corrTrendOptions(indicator.calcParams)),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default corrTrend
