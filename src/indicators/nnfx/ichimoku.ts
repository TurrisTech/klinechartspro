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
import { drawRange, fillBetween, signColors, signLineStyle, withAlpha } from './paint'

/**
 * ICHIMOKU -- Ichimoku Kinko Hyo on the price pane, as MetaTrader 5's `Ichimoku.mq5` computes it
 * (windicators `ichimoku`, catalog/trend/ichimoku.toml, the code the windicators NNFX scan ran):
 * the C1 the scan ranked 6th on 1D, at tenkan 4, kijun 20, senkou 21.
 *
 * Parameters: [tenkan, kijun, senkou, inverted], default [4, 20, 21, 1] (MetaTrader's own: 9, 26,
 * 52). windicators' `span_shift` is fixed at 0, the scan's: see "Not shifted" below.
 *
 *   tenkan   = (highest high + lowest low) / 2 over the last `tenkan` bars
 *   kijun    = the same over `kijun` bars
 *   senkou_a = (tenkan + kijun) / 2
 *   senkou_b = the same midpoint over `senkou` bars
 *
 * Each window is the bar and the ones before it, fewer at the start of history (MetaTrader's
 * Highest / Lowest), and, as MetaTrader's PLOT_DRAW_BEGIN hides them, tenkan is blank before bar
 * `tenkan`, kijun before bar `kijun` and both spans before bar `senkou` - 1. The chikou span is
 * the close itself and is not drawn.
 *
 * **Not shifted.** A chart conventionally draws the two spans `kijun` bars to the RIGHT of the bar
 * that computed them (the cloud). windicators keeps every output at the bar whose data computed
 * it, and the scan read them there (`span_shift` 0). So does this template: the senkou B drawn over
 * bar t is the `senkou`-bar midpoint ending at t, not the one ending `kijun` bars earlier, and
 * there is no cloud ahead of the last bar. Compare it with a conventional Ichimoku and its span B sits `kijun`
 * bars to the left.
 *
 * The C1 reading the scan tested is KIJUN against SENKOU B with `inverted` 1 (+2.21 %/yr per pair,
 * 21 of 28 pairs positive): LONG while the kijun is BELOW senkou B and short while above; 0 is the
 * conventional reading. At kijun 20 and senkou 21 the two windows differ by one bar, the one 20
 * bars back, so the two lines are equal (no signal) unless that bar holds the 21-bar high or low:
 * senkou B is above the kijun -- long, inverted -- when that bar's high stands further above the
 * 20 bars since than its low stands below them, i.e. when the bar four weeks back (on 1D) was the
 * top of the range. On the 28 pairs' 1D bars the two were equal on 72% of bars. The kijun is
 * drawn in the colour of the side it gives, senkou B in the neutral colour, and the area between
 * them shaded by side; the tenkan is context. Senkou A is computed (and checked) but not drawn.
 *
 * Windowed (FIR), so no warm-up: every value drawn spans whole windows, and so equals a
 * from-inception one (senkou A excepted when `senkou` is shorter than `tenkan` or `kijun`: its
 * draw-begin then comes before their windows are full). Measured on the 28 prod pairs' 1D bars from
 * 4,648 start points (2026-10-15), the reading agreed with the scan's from-2005 one on every bar
 * from its first.
 *
 * Locked to windicators by fixtures/wscan_r3_trend.json.
 */

export interface Ichimoku {
  [key: string]: number | undefined
  tenkan?: number
  kijun?: number
  senkou_a?: number
  senkou_b?: number
  state?: number
}

const DEFAULTS = [4, 20, 21, 1]

export function ichimokuSettings(calcParams: readonly unknown[]): { tenkan: number; kijun: number; senkou: number; dir: number } {
  const tenkan = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1))
  const kijun = Math.min(100000, countParam(calcParams[1], DEFAULTS[1], 1))
  const senkou = Math.min(100000, countParam(calcParams[2], DEFAULTS[2], 1))
  const dir = countParam(calcParams[3], 1, 0) >= 1 ? -1 : 1
  return { tenkan, kijun, senkou, dir }
}

/** MetaTrader's Highest / Lowest: the extreme of the `range` values ending at `i`, fewer at the start. */
function midpoint(high: readonly number[], low: readonly number[], range: number, i: number): number {
  let hi = high[i]
  let lo = low[i]
  for (let k = i; k > i - range && k >= 0; k--) {
    if (hi < high[k]) hi = high[k]
    if (lo > low[k]) lo = low[k]
  }
  return (hi + lo) / 2
}

export function ichimokuRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Ichimoku[] {
  const { tenkan, kijun, senkou, dir } = ichimokuSettings(calcParams)
  const high = bars.map((b) => b.high)
  const low = bars.map((b) => b.low)
  return bars.map((_, i) => {
    const tk = midpoint(high, low, tenkan, i)
    const kj = midpoint(high, low, kijun, i)
    const row: Ichimoku = {}
    if (i >= tenkan) row.tenkan = tk
    if (i >= kijun) row.kijun = kj
    if (i >= senkou - 1) {
      row.senkou_a = (tk + kj) / 2
      row.senkou_b = midpoint(high, low, senkou, i)
    }
    if (row.kijun !== undefined && row.senkou_b !== undefined) {
      const side = Math.sign(row.kijun - row.senkou_b)
      row.state = side === 0 ? 0 : dir * side
    }
    return row
  })
}

const ichimoku: IndicatorTemplate<Ichimoku, number> = {
  name: 'ICHIMOKU',
  shortName: 'Ichimoku (unshifted)',
  series: 'price',
  calcParams: DEFAULTS,
  precision: 5,
  figures: [
    { key: 'tenkan', title: 'Tenkan: ', type: 'line' },
    {
      key: 'kijun',
      title: 'Kijun: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'senkou_b', title: 'Senkou B: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => ichimokuRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const inverted = ichimokuSettings(indicator.calcParams).dir < 0
    const [above, below] = inverted ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'kijun', 'senkou_b', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.18), withAlpha(below, 0.18))
    return false
  }
}

export default ichimoku
