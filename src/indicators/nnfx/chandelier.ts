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

import { atr, countParam, realParam } from './mt4'
import { drawRange, flipArrows, signColors, trendAges } from './paint'

/**
 * CHANDELIER -- the Chandelier Exit (MQLService, "mod2008fxtsd"; Stonehill's copy), a ratcheting
 * ATR stop on the price pane, read as an NNFX baseline.
 *
 * Parameters: [range, atr, mult, shift, arrows], default [6, 7, 2.5, 0, 1] -- the setting the NNFX
 * discovery ranked best for it as a baseline on 8h (14/28 pairs positive; the source's default is
 * range 7, ATR 9). See README.md in this directory. `arrows` 1 marks each flip on the bar.
 *
 * The long stop is the highest high of the last `range` bars less `mult` x ATR(atr); the short
 * stop is the lowest low plus the same. The direction turns LONG when a close is above the
 * previous bar's short stop and SHORT when one is below the previous bar's long stop, and only the
 * stop on the active side is drawn -- the long stop (the indicator theme's up colour) below price,
 * the short stop (its down colour) above, each its own line so it breaks at a flip. While a side
 * is active its stop only ratchets: the long stop never falls, the short stop never rises. `shift`
 * computes each bar's stop from the bar `shift` bars earlier, as the source allows.
 *
 * ATR is MT4's (an SMA of true range). Nothing is drawn before the first turn; a turn needs only
 * its own bar's close, so it is knowable at that close -- and the forming bar can turn and turn
 * back until it closes.
 */

export interface Chandelier {
  [key: string]: number | undefined
  /** The active stop while long; absent otherwise -- a separate key so the line breaks at a flip. */
  long?: number
  /** The active stop while short. */
  short?: number
  /** +1 long, -1 short; absent before the first turn. */
  trend?: number
  age?: number
}

export interface ChandelierOptions {
  range: number
  atr: number
  mult: number
  shift: number
}

export function chandelierOptions(calcParams: readonly unknown[]): ChandelierOptions {
  return {
    range: countParam(calcParams[0], 6, 1),
    atr: countParam(calcParams[1], 7, 1),
    mult: realParam(calcParams[2], 2.5, 0),
    shift: countParam(calcParams[3], 0, 0)
  }
}

/** The active stop and direction per bar, as the source's two colour buffers merged. */
export function chandelierExit(bars: readonly KLineData[], options: ChandelierOptions): Chandelier[] {
  const { range, shift, mult } = options
  const a = atr(bars, options.atr)
  const n = bars.length
  const longStop = new Array<number>(n).fill(Number.NaN)
  const shortStop = new Array<number>(n).fill(Number.NaN)
  const rows: Chandelier[] = []
  let d = 0
  for (let t = 0; t < n; t++) {
    const s = t - shift
    if (s - range + 1 >= 0 && Number.isFinite(a[s])) {
      let hh = bars[s].high
      let ll = bars[s].low
      for (let j = s - range + 1; j < s; j++) {
        if (bars[j].high > hh) hh = bars[j].high
        if (bars[j].low < ll) ll = bars[j].low
      }
      const band = a[s] * mult
      longStop[t] = hh - band
      shortStop[t] = ll + band
    }
    const row: Chandelier = {}
    rows.push(row)
    if (t === 0) continue
    // A comparison with NaN is false, so no stop yet holds the direction.
    const close = bars[t].close
    if (close > shortStop[t - 1]) d = 1
    if (close < longStop[t - 1]) d = -1
    if (d > 0) {
      if (longStop[t] < longStop[t - 1]) longStop[t] = longStop[t - 1]
      if (Number.isFinite(longStop[t])) {
        row.long = longStop[t]
        row.trend = 1
      }
    } else if (d < 0) {
      if (shortStop[t] > shortStop[t - 1]) shortStop[t] = shortStop[t - 1]
      if (Number.isFinite(shortStop[t])) {
        row.short = shortStop[t]
        row.trend = -1
      }
    }
  }
  trendAges(rows.map((r) => r.trend)).forEach((age, i) => {
    if (age !== undefined) rows[i].age = age
  })
  return rows
}

const chandelier: IndicatorTemplate<Chandelier, number> = {
  name: 'CHANDELIER',
  shortName: 'Chandelier',
  series: 'price',
  calcParams: [6, 7, 2.5, 0, 1],
  precision: 5,
  figures: [
    { key: 'long', title: 'Long stop: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).up }) },
    { key: 'short', title: 'Short stop: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).down }) }
  ],
  calc: (dataList: KLineData[], indicator) => chandelierExit(dataList, chandelierOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    if (indicator.calcParams[4] === 0) return false
    const result = indicator.result
    flipArrows(ctx, chart, xAxis, yAxis, result.map((r) => r?.trend), drawRange(chart, result.length),
      signColors(indicator, chart.getStyles().indicator))
    return false
  }
}

export default chandelier
