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

import { countParam, realParam, value } from './mt4'
import { guide, guideColor, signLineStyle } from './paint'

/**
 * TTF -- M.H. Pee's Trend Trigger Factor, a sub-pane oscillator around zero (levels +-100).
 *
 * Parameters: [period, t3, b], default [45, 0, 0.7] -- the setting the NNFX discovery ranked best
 * for it on 8h, as a zero cross (14/28 pairs positive; the source's default period is 15). See
 * README.md in this directory.
 *
 * Buying power is the highest high of the recent `period` bars less the lowest low of the
 * `period` bars before them; selling power is the older window's highest high less the recent
 * one's lowest low; TTF = 200 (buy - sell) / (buy + sell), 0 when both are 0. Long above zero,
 * short below: the line takes the up colour above zero and the down colour below.
 *
 * Levels are each version's own: +-100 for the MQL5 one, +-75 for Bilak's. Both are checked
 * against their published sources (sources.test.ts); Bilak's MT4 re-applies the T3 step on every
 * tick of the forming bar (its EMA stages are globals), which here is one step per bar.
 *
 * `t3` chooses between the two versions in the Stonehill library:
 *   0  -- MetaQuotes' MQL5 TTF (2018), unsmoothed. Its older window starts one bar early, so the
 *         two windows share a bar -- the source's quirk, kept.
 *   n  -- Nick Bilak's MT4 TTF (2005): disjoint windows, then a Tillson T3 of period n and volume
 *         factor `b`, its six EMA stages starting from zero at the first value. (The 1D shortlist
 *         candidate is this one at [12, 4, 0.7]: 15/28 pairs positive on 1D, against 13/28 for
 *         the MQL5 version's best.)
 */

export interface Ttf {
  [key: string]: number | undefined
  ttf?: number
}

export interface TtfOptions {
  period: number
  t3: number
  b: number
}

export function ttfOptions(calcParams: readonly unknown[]): TtfOptions {
  return {
    period: countParam(calcParams[0], 45, 1),
    t3: countParam(calcParams[1], 0, 0),
    b: realParam(calcParams[2], 0.7, 0)
  }
}

function highest(bars: readonly KLineData[], from: number, to: number): number {
  let v = Number.NEGATIVE_INFINITY
  for (let j = from; j <= to; j++) if (bars[j].high > v) v = bars[j].high
  return v
}

function lowest(bars: readonly KLineData[], from: number, to: number): number {
  let v = Number.POSITIVE_INFINITY
  for (let j = from; j <= to; j++) if (bars[j].low < v) v = bars[j].low
  return v
}

function factor(buy: number, sell: number): number {
  return buy + sell !== 0 ? (200 * (buy - sell)) / (buy + sell) : 0
}

// MetaQuotes' MQL5 TTF: recent window [t-p+1, t], older [t-2p+2, t-p+1] (sharing bar t-p+1).
function ttfMql5(bars: readonly KLineData[], p: number): number[] {
  return bars.map((_, t) => {
    if (t < 2 * p - 2) return Number.NaN
    const buy = highest(bars, t - p + 1, t) - lowest(bars, t - 2 * p + 2, t - p + 1)
    const sell = highest(bars, t - 2 * p + 2, t - p + 1) - lowest(bars, t - p + 1, t)
    return factor(buy, sell)
  })
}

// Nick Bilak's MT4 TTF: recent window [t-p+1, t], older [t-2p+1, t-p], then T3(t3, b).
function ttfBilak(bars: readonly KLineData[], p: number, t3: number, b: number): number[] {
  const b2 = b * b
  const b3 = b2 * b
  const c1 = -b3
  const c2 = 3 * (b2 + b3)
  const c3 = -3 * (2 * b2 + b + b3)
  const c4 = 1 + 3 * b + b3 + 3 * b2
  const r = 1 + 0.5 * (Math.max(1, t3) - 1)
  const w1 = 2 / (r + 1)
  const w2 = 1 - w1
  let e1 = 0
  let e2 = 0
  let e3 = 0
  let e4 = 0
  let e5 = 0
  let e6 = 0
  return bars.map((_, t) => {
    if (t < 2 * p) return Number.NaN
    const buy = highest(bars, t - p + 1, t) - lowest(bars, t - 2 * p + 1, t - p)
    const sell = highest(bars, t - 2 * p + 1, t - p) - lowest(bars, t - p + 1, t)
    // Bilak writes (bp - sp) / (0.5 (bp + sp)) * 100, the same factor.
    const x = buy + sell !== 0 ? ((buy - sell) / (0.5 * (buy + sell))) * 100 : 0
    e1 = w1 * x + w2 * e1
    e2 = w1 * e1 + w2 * e2
    e3 = w1 * e2 + w2 * e3
    e4 = w1 * e3 + w2 * e4
    e5 = w1 * e4 + w2 * e5
    e6 = w1 * e5 + w2 * e6
    return c1 * e6 + c2 * e5 + c3 * e4 + c4 * e3
  })
}

export function trendTriggerFactor(bars: readonly KLineData[], options: TtfOptions): Ttf[] {
  const out = options.t3 === 0 ? ttfMql5(bars, options.period) : ttfBilak(bars, options.period, options.t3, options.b)
  return out.map((v) => ({ ttf: value(v) }))
}

const ttf: IndicatorTemplate<Ttf, number> = {
  name: 'TTF',
  shortName: 'TTF',
  calcParams: [45, 0, 0.7],
  precision: 2,
  figures: [
    {
      key: 'ttf',
      title: 'TTF: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => signLineStyle(Math.sign(data.current?.ttf ?? 0), indicator, defaultStyles)
    }
  ],
  calc: (dataList: KLineData[], indicator) => trendTriggerFactor(dataList, ttfOptions(indicator.calcParams)),
  draw: ({ ctx, chart, indicator, bounding, yAxis }) => {
    const color = guideColor(chart)
    // Each version's own levels: the MQL5 one's overbought/oversold +-100, Bilak's TopLine /
    // BottomLine +-75 (the step his signal buffer draws).
    const level = ttfOptions(indicator.calcParams).t3 === 0 ? 100 : 75
    guide(ctx, bounding, yAxis, 0, color, false)
    guide(ctx, bounding, yAxis, level, color)
    guide(ctx, bounding, yAxis, -level, color)
    return false
  }
}

export default ttf
