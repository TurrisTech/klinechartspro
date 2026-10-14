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
 * PTL -- the Perfect Trend Line on the price pane, as the Stonehill library's `ptl_fast.mq4`
 * computes it (windicators `perfect_trend_line`, the code the windicators NNFX scan ran): the C2 of
 * the scan's system 5, at slow length 10, fast length 2.
 *
 * Parameters: [slow, fast, inverted], default [10, 2, 1] (the source's own: 7, 3).
 *
 * Two stop-and-reverse lines. Each sits at the lowest low of its window (the bar and the length - 1
 * before it) while the close is above the line's previous value, and at the highest high
 * otherwise. The source reads the line before the oldest bar as 0, so the first bar takes the
 * lowest lows. Its pip displacements are left at 0, as the scan ran them.
 *
 * The C2 reading the scan tested is the close against the SLOW line with `inverted` 1: it confirms
 * LONG while the close is BELOW the slow line and short while above; 0 is the conventional reading.
 * The slow line is drawn in the colour of the side it gives; the fast line is context.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Ptl {
  [key: string]: number | undefined
  slow?: number
  fast?: number
  state?: number
}

const DEFAULTS = [10, 2, 1]

/** The highest high of bar t and the count - 1 before it, cut at the oldest bar. */
function highest(x: readonly number[], t: number, count: number): number {
  let m = x[t]
  for (let k = t - 1; k >= Math.max(0, t - count + 1); k--) if (x[k] > m) m = x[k]
  return m
}

function lowest(x: readonly number[], t: number, count: number): number {
  let m = x[t]
  for (let k = t - 1; k >= Math.max(0, t - count + 1); k--) if (x[k] < m) m = x[k]
  return m
}

export function ptlRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Ptl[] {
  const slowLength = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const fastLength = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const dir = countParam(calcParams[2], 1, 0) >= 1 ? -1 : 1
  const h = bars.map((b) => b.high)
  const l = bars.map((b) => b.low)
  let prevSlow = 0
  let prevFast = 0
  return bars.map((bar, t) => {
    const c = bar.close
    const slow = c > prevSlow ? lowest(l, t, slowLength) : highest(h, t, slowLength)
    const fast = c > prevFast ? lowest(l, t, fastLength) : highest(h, t, fastLength)
    prevSlow = slow
    prevFast = fast
    return { slow, fast, state: dir * Math.sign(c - slow) }
  })
}

const ptl: IndicatorTemplate<Ptl, number> = {
  name: 'PTL',
  shortName: 'Perfect Trend Line',
  series: 'price',
  calcParams: DEFAULTS,
  precision: 5,
  figures: [
    {
      key: 'slow',
      title: 'Slow: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'fast', title: 'Fast: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => ptlRows(dataList, indicator.calcParams)
}

export default ptl
