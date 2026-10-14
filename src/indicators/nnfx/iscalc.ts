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
import { guide, guideColor, signColors, signLineStyle } from './paint'

/**
 * IS_CALC -- IS Calculation in a sub-pane, as the Stonehill library's `IS Calculation.mq4`
 * computes it (windicators `is_calculation`, the code the windicators NNFX scan ran): the C2 of the
 * scan's system 4 (re-ranked, README.md), at period 5, nbchandelier 22.
 *
 * Parameters: [period, nbchandelier, lag, inverted], default [5, 22, 0, 1] (the source's own: 10,
 * 10, 0).
 *
 *   EMA     = MT4's EMA of the close over `period`, seeded with the oldest close
 *   slope   = (EMA - EMA `nbchandelier` bars earlier) / nbchandelier   ("Pente")
 *   trigger = MT4's iMAOnArray EMA of the slope buffer over `period + lag`
 *
 * The C2 reading the scan tested is the SLOPE against zero with `inverted` 1: it confirms LONG
 * while the slope is BELOW zero and short while above; 0 is the conventional reading. The slope is
 * drawn in the colour of the side it gives; the trigger is context.
 *
 * The source fills the slope buffer with MT4's EMPTY_VALUE (2,147,483,647) before writing it, and
 * iMAOnArray seeds its EMA with that, so the trigger reads in the billions on its first bars and
 * decays by (1 - 2 / (period + lag + 1)) a bar. The template leaves the trigger blank until what is
 * left of that seed is below 1e-12 (about 120 bars at the defaults), where windicators -- and MT4 --
 * draw it.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface IsCalc {
  [key: string]: number | undefined
  slope?: number
  trigger?: number
  state?: number
}

/** MQL4's EMPTY_VALUE: what an indicator buffer holds before it is written. */
export const EMPTY_VALUE = 2147483647

const DEFAULTS = [5, 22, 0, 1]

/** The first bar at which the EMPTY_VALUE seed left in the trigger is below 1e-12. */
export function triggerFrom(nb: number, n: number): number {
  const keep = 1 - 2 / (n + 1)
  if (keep <= 0) return nb
  return nb - 1 + Math.ceil(Math.log(EMPTY_VALUE / 1e-12) / -Math.log(keep))
}

export function isCalcRows(bars: readonly KLineData[], calcParams: readonly unknown[]): IsCalc[] {
  const period = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const nb = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const lag = Math.max(1 - period, Math.min(100000, countParam(calcParams[2], DEFAULTS[2], -100000)))
  const dir = countParam(calcParams[3], 1, 0) >= 1 ? -1 : 1
  const m = bars.length
  // MT4's iMA MODE_EMA, seeded with the oldest close.
  const ema = new Array<number>(m)
  const pr = 2 / (period + 1)
  for (let t = 0; t < m; t++) ema[t] = t === 0 ? bars[0].close : bars[t].close * pr + ema[t - 1] * (1 - pr)
  const buf = new Array<number>(m).fill(EMPTY_VALUE)
  for (let t = nb; t < m; t++) buf[t] = (ema[t] - ema[t - nb]) / nb
  // MetaQuotes' iMAOnArray MODE_EMA over the whole buffer: 0 until period + lag - 1 elements.
  const n = period + lag
  const trig = new Array<number>(m).fill(0)
  if (m >= n) {
    const a = 2 / (n + 1)
    let e = buf[0]
    if (n - 1 <= 0) trig[0] = e
    for (let t = 1; t < m; t++) {
      e = buf[t] * a + e * (1 - a)
      if (t >= n - 1) trig[t] = e
    }
  }
  const shown = triggerFrom(nb, n)
  return bars.map((_, t) => {
    if (t < nb) return {}
    const row: IsCalc = { slope: value(buf[t]), trigger: t >= shown ? value(trig[t]) : undefined }
    if (row.slope !== undefined) row.state = dir * Math.sign(row.slope)
    return row
  })
}

const isCalc: IndicatorTemplate<IsCalc, number> = {
  name: 'IS_CALC',
  shortName: 'IS Calculation',
  calcParams: DEFAULTS,
  precision: 6,
  figures: [
    {
      key: 'slope',
      title: 'Slope: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'trigger', title: 'Trigger: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => isCalcRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    return false
  }
}

export default isCalc
