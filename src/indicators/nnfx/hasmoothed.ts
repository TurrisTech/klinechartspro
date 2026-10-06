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

import { countParam, MT4_MA_METHODS, maByMethod, value } from './mt4'
import { drawRange, priceLegends, trendAges, trendText, withAlpha } from './paint'

/**
 * HA_SMOOTHED -- Heiken Ashi Smoothed (Forex-TSD 2006, "mod by Raff"; Stonehill's copy), smoothed
 * Heiken Ashi candles drawn over the price pane.
 *
 * Parameters: [period, method, period2, method2, opacity], default [6, 2, 2, 3, 40] -- the
 * source's MA settings (SMMA 6, then LWMA 2), which are also the ones the NNFX discovery ranked
 * best for it on 8h (15/28 pairs positive -- but as an artefact form, the smoothed open against the
 * smoothed low; the colour drawn here ranked 14/28 on 1D at [9, 2, 3, 3] and 6/28 on 8h). See
 * README.md in this directory. `method` and
 * `method2` are MT4's MA methods: 0 SMA, 1 EMA, 2 SMMA, 3 LWMA. `opacity` (%) fills the bodies;
 * the outlines are always drawn.
 *
 * The bar's open, high, low and close are each smoothed by MA(period, method); Heiken Ashi
 * candles are built from those (open = the previous HA candle's (open + close) / 2, close = the
 * smoothed OHLC's mean, high/low = the extremes of all of them); and each of the candle's four
 * series is smoothed again by MA(period2, method2). A candle is up-coloured while its smoothed
 * close is above its smoothed open, down-coloured below -- the colour change is the signal, and
 * an equal pair holds the colour before it. The wick spans the two smoothed extremes; smoothing
 * them separately from the body means a wick need not contain its body, exactly as in MT4.
 *
 * The first HA open reads an uninitialised buffer in the source; here it is seeded with the first
 * smoothed (open + close) / 2. IIR throughout (the HA open, an EMA or SMMA), so the earliest
 * candles depend slightly on where the loaded history starts.
 */

export interface HaSmoothed {
  [key: string]: number | undefined
  open?: number
  close?: number
  high?: number
  low?: number
  /** +1 up candle, -1 down candle; absent before the first candle with a colour. */
  trend?: number
  /** Bars since the colour last changed, the changing bar being 1; absent before the first change. */
  age?: number
}

export interface HaSmoothedOptions {
  period: number
  method: number
  period2: number
  method2: number
}

export function haSmoothedOptions(calcParams: readonly unknown[]): HaSmoothedOptions {
  return {
    period: countParam(calcParams[0], 6, 1),
    method: Math.min(3, countParam(calcParams[1], 2, 0)),
    period2: countParam(calcParams[2], 2, 1),
    method2: Math.min(3, countParam(calcParams[3], 3, 0))
  }
}

export function heikenAshiSmoothed(bars: readonly KLineData[], options: HaSmoothedOptions): HaSmoothed[] {
  const { period, method, period2, method2 } = options
  const mo = maByMethod(bars.map((b) => b.open), period, method)
  const mh = maByMethod(bars.map((b) => b.high), period, method)
  const ml = maByMethod(bars.map((b) => b.low), period, method)
  const mc = maByMethod(bars.map((b) => b.close), period, method)

  // The source's four buffers: HA open, HA close, and the two extremes ordered by colour.
  const n = bars.length
  const haOpen = new Array<number>(n).fill(Number.NaN)
  const haClose = new Array<number>(n).fill(Number.NaN)
  const ext1 = new Array<number>(n).fill(Number.NaN)
  const ext2 = new Array<number>(n).fill(Number.NaN)
  let started = false
  for (let i = 0; i < n; i++) {
    if (!(Number.isFinite(mo[i]) && Number.isFinite(mh[i]) && Number.isFinite(ml[i]) && Number.isFinite(mc[i]))) continue
    const hao = started ? (haOpen[i - 1] + haClose[i - 1]) / 2 : (mo[i] + mc[i]) / 2
    started = true
    const hac = (mo[i] + mh[i] + ml[i] + mc[i]) / 4
    const hah = Math.max(mh[i], hao, hac)
    const hal = Math.min(ml[i], hao, hac)
    ext1[i] = hao < hac ? hal : hah
    ext2[i] = hao < hac ? hah : hal
    haOpen[i] = hao
    haClose[i] = hac
  }
  const s1 = maByMethod(ext1, period2, method2)
  const s2 = maByMethod(ext2, period2, method2)
  const so = maByMethod(haOpen, period2, method2)
  const sc = maByMethod(haClose, period2, method2)

  let trend = 0
  const rows: HaSmoothed[] = so.map((o, i) => {
    const c = sc[i]
    if (!(Number.isFinite(o) && Number.isFinite(c))) return {}
    if (c > o) trend = 1
    else if (c < o) trend = -1
    // numpy's fmax/fmin: a NaN on one side gives the other.
    const hi = Number.isFinite(s1[i]) ? (Number.isFinite(s2[i]) ? Math.max(s1[i], s2[i]) : s1[i]) : s2[i]
    const lo = Number.isFinite(s1[i]) ? (Number.isFinite(s2[i]) ? Math.min(s1[i], s2[i]) : s1[i]) : s2[i]
    const row: HaSmoothed = { open: o, close: c, high: value(hi), low: value(lo) }
    if (trend !== 0) row.trend = trend
    return row
  })
  const ages = trendAges(rows.map((r) => r.trend))
  ages.forEach((age, i) => {
    if (age !== undefined) rows[i].age = age
  })
  return rows
}

const haSmoothed: IndicatorTemplate<HaSmoothed, number> = {
  name: 'HA_SMOOTHED',
  shortName: 'HA Smoothed',
  series: 'price',
  calcParams: [6, 2, 2, 3, 40],
  precision: 5,
  shouldOhlc: false,
  // No `type`: `draw` is the only rendering and the legend is built in createTooltipDataSource.
  // As figures they still keep the candles inside the y-axis.
  figures: [
    { key: 'open', title: 'O: ' },
    { key: 'high', title: 'H: ' },
    { key: 'low', title: 'L: ' },
    { key: 'close', title: 'C: ' }
  ],
  calc: (dataList: KLineData[], indicator) => heikenAshiSmoothed(dataList, haSmoothedOptions(indicator.calcParams)),
  createTooltipDataSource: ({ chart, indicator, crosshair }) => {
    const { period, method, period2, method2 } = haSmoothedOptions(indicator.calcParams)
    const { upColor, downColor } = chart.getStyles().candle.bar
    const neutral = chart.getStyles().indicator.tooltip.legend.color
    const result = indicator.result
    const row = result[crosshair.dataIndex ?? result.length - 1] ?? {}
    const color = row.trend === undefined ? neutral : row.trend > 0 ? upColor : downColor
    const oldest = result.reduce((m, r) => Math.max(m, r?.age ?? 0), 0)
    return {
      name: indicator.shortName,
      calcParamsText: `(${MT4_MA_METHODS[method]} ${period}, ${MT4_MA_METHODS[method2]} ${period2})`,
      legends: [
        ...priceLegends(chart, indicator, row, [
          { key: 'open', title: 'O: ', color },
          { key: 'high', title: 'H: ', color },
          { key: 'low', title: 'L: ', color },
          { key: 'close', title: 'C: ', color }
        ]),
        {
          title: { text: 'Trend: ', color: neutral },
          value: { text: trendText(row.trend, row.age), color, reserve: trendText(-1, oldest > 0 ? oldest : undefined) }
        }
      ],
      features: chart.getStyles().indicator.tooltip.features
    }
  },
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    const result = indicator.result
    const opacity = Math.min(100, countParam(indicator.calcParams[4] ?? 40, 40, 0)) / 100
    const { upColor, downColor } = chart.getStyles().candle.bar
    const { bar: barWidth } = chart.getBarSpace()
    const half = Math.max(1, Math.floor(barWidth * 0.35))
    const { from, to } = drawRange(chart, result.length)
    ctx.lineWidth = 1
    // The canvas arrives with the last-price line's dash still set.
    ctx.setLineDash([])
    for (let i = from; i <= to; i++) {
      const r = result[i]
      if (r?.open === undefined || r.close === undefined || r.trend === undefined) continue
      const color = r.trend > 0 ? upColor : downColor
      const x = Math.round(xAxis.convertToPixel(i)) + 0.5
      const yo = yAxis.convertToPixel(r.open)
      const yc = yAxis.convertToPixel(r.close)
      ctx.strokeStyle = color
      if (r.high !== undefined && r.low !== undefined) {
        ctx.beginPath()
        ctx.moveTo(x, yAxis.convertToPixel(r.high))
        ctx.lineTo(x, yAxis.convertToPixel(r.low))
        ctx.stroke()
      }
      const top = Math.min(yo, yc)
      const height = Math.max(1, Math.abs(yo - yc))
      if (opacity > 0) {
        ctx.fillStyle = withAlpha(color, opacity)
        ctx.fillRect(x - half, top, 2 * half, height)
      }
      ctx.strokeRect(x - half, top, 2 * half, height)
    }
    return true
  }
}

export default haSmoothed
