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

import { atr as atrMt4, countParam, value } from './mt4'
import { priceLegends } from './paint'
import { atrWilder } from './talib'

/**
 * ATR -- the average true range in a sub-pane, with the NNFX stop distance beside it.
 *
 * Parameters: [period, method], default [14, 0].
 *
 * A bar's true range is the largest of high - low, |high - previous close| and |low - previous
 * close|. `method` 0 averages the last `period` of them with a simple mean -- MetaTrader 4's iATR,
 * the ATR the NNFX study traded with (its 1x ATR distance rule, 1.5x ATR stop, 1x ATR target and
 * trailing stop). `method` 1 is Wilder's smoothing as TA-Lib computes it; TradingView's ATR is
 * Wilder's too but seeds differently, and agrees with it within a few periods.
 *
 * The legend shows the ATR and 1.5 x ATR, the NNFX stop distance, in price units (the pane's
 * precision follows the instrument's). Locked to MT4's definition (the simulator's) and to TA-Lib
 * by fixtures/library_parity.json.
 */

export interface Atr {
  [key: string]: number | undefined
  atr?: number
  stop?: number
}

export function atrOptions(calcParams: readonly unknown[]): { period: number; method: number } {
  return { period: countParam(calcParams[0], 14, 1), method: Math.min(1, countParam(calcParams[1], 0, 0)) }
}

export function averageTrueRange(bars: readonly KLineData[], period: number, method: number): Atr[] {
  const a = method === 1 ? atrWilder(bars, period) : atrMt4(bars, period)
  return a.map((v) => ({ atr: value(v), stop: value(1.5 * v) }))
}

const atr: IndicatorTemplate<Atr, number> = {
  name: 'ATR',
  shortName: 'ATR',
  series: 'price',
  calcParams: [14, 0],
  precision: 5,
  // `stop` is a row field the legend reads, not a figure: a figure would stretch the pane's axis
  // to 1.5x the line.
  figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
  calc: (dataList: KLineData[], indicator) => {
    const { period, method } = atrOptions(indicator.calcParams)
    return averageTrueRange(dataList, period, method)
  },
  createTooltipDataSource: ({ chart, indicator, crosshair }) => {
    const { period, method } = atrOptions(indicator.calcParams)
    const result = indicator.result
    const row = result[crosshair.dataIndex ?? result.length - 1] ?? {}
    const lines = chart.getStyles().indicator.lines
    const neutral = chart.getStyles().indicator.tooltip.legend.color
    return {
      name: indicator.shortName,
      calcParamsText: `(${period}, ${method === 1 ? 'Wilder' : 'SMA'})`,
      legends: priceLegends(chart, indicator, row, [
        { key: 'atr', title: 'ATR: ', color: lines[0]?.color ?? neutral },
        { key: 'stop', title: 'Stop 1.5×: ', color: neutral }
      ]),
      features: chart.getStyles().indicator.tooltip.features
    }
  }
}

export default atr
