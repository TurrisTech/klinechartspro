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
import { signLineStyle } from './paint'

/**
 * LINREG -- TA-Lib's linear-regression intercept on the price pane (the NNFX study's System C
 * C2: the close above or below the 28-bar intercept).
 *
 * Parameters: [period], default [28].
 *
 * The least-squares line through the last `period` closes, read at the OLDEST bar of the window:
 * TA-Lib's LINEARREG_INTERCEPT is the fitted line's value `period - 1` bars ago, not at the latest
 * bar (that is LINEARREG). It therefore lags price by design -- in a steady trend the close sits
 * on the trend's side of it -- which is what made it usable as a direction filter.
 *
 * The line takes the up colour while the close is above it and the down colour while below: the
 * C2 reading. Locked to TA-Lib by fixtures/library_parity.json.
 */

export interface LinReg {
  [key: string]: number | undefined
  intercept?: number
  /** +1 close above the line, -1 below, 0 on it. */
  side?: number
}

export function linRegOptions(calcParams: readonly unknown[]): { period: number } {
  return { period: countParam(calcParams[0], 28, 2) }
}

export function linearRegressionIntercept(bars: readonly KLineData[], n: number): LinReg[] {
  // x = 0 at the oldest bar of the window, n - 1 at the newest.
  const sumX = (n * (n - 1)) / 2
  const sumXX = ((n - 1) * n * (2 * n - 1)) / 6
  const divisor = n * sumXX - sumX * sumX
  return bars.map((bar, i) => {
    if (i < n - 1) return {}
    let sumY = 0
    let sumXY = 0
    for (let k = 0; k < n; k++) {
      const y = bars[i - n + 1 + k].close
      sumY += y
      sumXY += k * y
    }
    const slope = (n * sumXY - sumX * sumY) / divisor
    const intercept = (sumY - slope * sumX) / n
    return { intercept: value(intercept), side: Math.sign(bar.close - intercept) }
  })
}

const linReg: IndicatorTemplate<LinReg, number> = {
  name: 'LINREG',
  shortName: 'LinReg Intercept',
  series: 'price',
  calcParams: [28],
  precision: 5,
  figures: [
    {
      key: 'intercept',
      title: 'Intercept: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.side, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => linearRegressionIntercept(dataList, linRegOptions(indicator.calcParams).period)
}

export default linReg
