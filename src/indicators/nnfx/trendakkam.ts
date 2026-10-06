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
 * TREND_AKKAM -- TREND AKKAM (Stonehill's copy, MQL4), an ATR trailing stop driven by the bar's
 * OPEN, on the price pane, read as an NNFX baseline.
 *
 * Parameters: [atr, factor, arrows], default [150, 6, 1] -- the ATR period the NNFX discovery
 * ranked best for it as a baseline on 8h (11/28 pairs positive; the source hard-codes ATR 100).
 * See README.md in this directory. `arrows` 1 marks each flip on the bar.
 *
 * The stop sits `factor` x ATR(atr) from the open. While the last two opens are above it, it
 * ratchets up towards open - distance and never falls; while they are below, down towards
 * open + distance and never rises; when an open crosses it, it jumps to the other side. Long while
 * the stop is below the open (up colour), short while above (down colour), each its own line so it
 * breaks at a flip.
 *
 * The NNFX study ranked it as a baseline on the CLOSE against this stop; the arrows mark the
 * indicator's own flips, where the OPEN crosses it, usually one bar after such a close.
 *
 * As the source (Mode 0): the distance is an EMA(1) of ATR, i.e. ATR itself, and ATR is MT4's (an
 * SMA of true range). The first stop starts below the first open, as MT4's comparison against a
 * zero stop does. A bar's stop needs its open and its own ATR, so it is final at its close.
 */

export interface TrendAkkam {
  [key: string]: number | undefined
  long?: number
  short?: number
  /** +1 while the stop is below the open, -1 while above. */
  trend?: number
  age?: number
}

export interface TrendAkkamOptions {
  atr: number
  factor: number
}

export function trendAkkamOptions(calcParams: readonly unknown[]): TrendAkkamOptions {
  return { atr: countParam(calcParams[0], 150, 1), factor: realParam(calcParams[1], 6, 0) }
}

/** The stop per bar, NaN until the ATR has a value. */
export function trendAkkamStop(bars: readonly KLineData[], options: TrendAkkamOptions): number[] {
  const a = atr(bars, options.atr)
  const out = new Array<number>(bars.length).fill(Number.NaN)
  let prev = 0
  let prevOpen = 0
  let have = false
  for (let t = 0; t < bars.length; t++) {
    if (!Number.isFinite(a[t])) continue
    const o = bars[t].open
    const d = a[t] * options.factor
    let cur: number
    if (!have) cur = o - d
    else if (o === prev) cur = prev
    else if (prevOpen < prev && o < prev) cur = Math.min(prev, o + d)
    else if (prevOpen > prev && o > prev) cur = Math.max(prev, o - d)
    else if (o > prev) cur = o - d
    else cur = o + d
    out[t] = cur
    prev = cur
    prevOpen = o
    have = true
  }
  return out
}

export function trendAkkam(bars: readonly KLineData[], options: TrendAkkamOptions): TrendAkkam[] {
  const stop = trendAkkamStop(bars, options)
  let side = 0
  const rows = stop.map((s, t): TrendAkkam => {
    if (!Number.isFinite(s)) return {}
    // An open exactly on the stop keeps the side it had.
    if (bars[t].open > s) side = 1
    else if (bars[t].open < s) side = -1
    if (side === 0) return {}
    return side > 0 ? { long: s, trend: 1 } : { short: s, trend: -1 }
  })
  trendAges(rows.map((r) => r.trend)).forEach((age, i) => {
    if (age !== undefined) rows[i].age = age
  })
  return rows
}

const trendAkkamTemplate: IndicatorTemplate<TrendAkkam, number> = {
  name: 'TREND_AKKAM',
  shortName: 'Trend Akkam',
  series: 'price',
  calcParams: [150, 6, 1],
  precision: 5,
  figures: [
    { key: 'long', title: 'Long stop: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).up }) },
    { key: 'short', title: 'Short stop: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).down }) }
  ],
  calc: (dataList: KLineData[], indicator) => trendAkkam(dataList, trendAkkamOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    if (indicator.calcParams[2] === 0) return false
    const result = indicator.result
    flipArrows(ctx, chart, xAxis, yAxis, result.map((r) => r?.trend), drawRange(chart, result.length),
      signColors(indicator, chart.getStyles().indicator))
    return false
  }
}

export default trendAkkamTemplate
