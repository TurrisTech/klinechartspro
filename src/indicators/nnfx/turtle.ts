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

import { countParam } from './mt4'
import { signColors, signLineStyle } from './paint'

/**
 * TURTLE -- the Turtle Trading Channel on the price pane, as the Stonehill library's
 * `TheTurtleTradingChannel.mq4` computes it (windicators `turtle_trading_channel`, the code the
 * windicators NNFX scan ran): the C2 of the scan's system 4, at trade period 10, stop period 5.
 *
 * Parameters: [trade, stop, inverted], default [10, 5, 1] (the source's own: 20, 10).
 *
 * A Donchian breakout state. The trend turns LONG on a close above the highest high of the
 * `trade` bars before this one, and SHORT on a close below their lowest low; otherwise it holds.
 * While long the line is that lowest low and the stop the lowest low of the last `stop` bars;
 * while short both are the highest highs. Nothing is drawn before the first breakout: the source's
 * trend buffer starts at MT4's EMPTY_VALUE, which is neither side. The source's `strict` setting
 * (a high or low through the channel also counts) is left off, as the scan ran it.
 *
 * The C2 reading the scan tested is the close against the LINE with `inverted` 1: it confirms LONG
 * while the close is BELOW the line and short while above. The close is above the line exactly
 * while the channel is long, so inverted is the channel's own trend reversed: a fade of 10-bar
 * breakouts. 0 is the conventional reading. The line is drawn in the colour of the side it gives;
 * the stop is context.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Turtle {
  [key: string]: number | undefined
  line?: number
  stop?: number
  /** The channel's own trend: +1 long, -1 short. */
  trend?: number
  state?: number
}

const DEFAULTS = [10, 5, 1]

/** `x[iHighest(count, start)]` over bars start, start - 1, ..., cut at the oldest bar. */
function highest(x: readonly number[], start: number, count: number): number {
  let v = x[start]
  for (let k = start - 1; k > start - count && k >= 0; k--) if (x[k] > v) v = x[k]
  return v
}

function lowest(x: readonly number[], start: number, count: number): number {
  let v = x[start]
  for (let k = start - 1; k > start - count && k >= 0; k--) if (x[k] < v) v = x[k]
  return v
}

export function turtleRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Turtle[] {
  const trade = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const stopPeriod = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const dir = countParam(calcParams[2], 1, 0) >= 1 ? -1 : 1
  const h = bars.map((b) => b.high)
  const l = bars.map((b) => b.low)
  let state = 0 // 0 is the source's EMPTY_VALUE: neither OP_BUY nor OP_SELL
  return bars.map((bar, t) => {
    if (t < 2) return {}
    const rhigh = highest(h, t - 1, trade)
    const rlow = lowest(l, t - 1, trade)
    if (bar.close > rhigh && state !== 1) state = 1
    else if (bar.close < rlow && state !== -1) state = -1
    if (state === 0) return {}
    const line = state === 1 ? rlow : rhigh
    const stop = state === 1 ? lowest(l, t - 1, stopPeriod) : highest(h, t - 1, stopPeriod)
    return { line, stop, trend: state, state: dir * Math.sign(bar.close - line) }
  })
}

const turtle: IndicatorTemplate<Turtle, number> = {
  name: 'TURTLE',
  shortName: 'Turtle Channel',
  series: 'price',
  calcParams: DEFAULTS,
  precision: 5,
  figures: [
    {
      key: 'line',
      title: 'Line: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'stop', title: 'Stop: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => turtleRows(dataList, indicator.calcParams)
}

export default turtle
