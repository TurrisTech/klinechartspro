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

import type { IndicatorTemplate, KLineData, TooltipLegend } from 'klinecharts'

import { arrow } from './swing'

/**
 * SSL -- the SSL Channel ("Semaphore Signal Level"), computed in the browser and drawn on the
 * price pane.
 *
 * Parameters: [length, ma, shift, signals, fill], default [15, 0, 0, 1, 12] -- SSL(15) over SMAs
 * in the TradingView form, the best universal baseline the NNFX discovery found on 1D and the one
 * its systems A, B and D are built on (notes/research/NoNonSenseForex/results/README.md). VP's own
 * "SSL Channel Chart Alert (10)" is [10, 0, 1].
 *
 * Two moving averages, one of the highs and one of the lows. The trend turns LONG on a close
 * above the high MA and SHORT on a close below the low MA, and holds while the close is between
 * them. The up line is the high MA while long and the low MA while short, the down line the
 * other one, so the two lines cross exactly when the trend flips -- the "two lines cross" a
 * No Nonsense Forex C1 reads (notes/research/NoNonSenseForex/README.md §8.1).
 *
 * `shift` is the one place the two published versions differ. The MT4 original (Kalenzo's, in
 * mladen's "SSL channel chart" -- the file VP used) compares a close with MAs ending at the
 * PREVIOUS bar, `iMA(..., i+1)`, while TradingView's "SSL channel" includes the bar's own high
 * and low. 0 is TradingView, the form the NNFX sweep tested; 1 is MT4, both lines one bar later.
 * Either way a value needs only its own bar's close, so a flip is knowable at that bar's close --
 * and on the live edge the forming bar can flip and flip back until it closes.
 *
 * `ma` picks the average of the TradingView multi-MA version the NNFX sweep tested
 * (`nnfx/ports/tv_ssl_multi_ma.py`): 0 SMA, 1 EMA, 2 WMA, 3 VWMA, 4 ALMA(0.85, 6), 5 HMA. The
 * whole computation is locked to that port by `fixtures/ssl_parity.json` (ssl.test.ts), at both
 * shifts.
 *
 * Before the first close outside the channel the trend is unknown and nothing is drawn -- the
 * scripts draw an implicit long there, a claim the bars do not make. From that close on the
 * trend is exact wherever the window starts (a close outside the channel sets it whatever came
 * before), but how long it has lasted is known only from the first flip, so the legend counts
 * bars from there.
 *
 * `signals` 1 puts an arrow on each flip bar (up below its low for long, down above its high
 * for short); `fill` shades the channel in the trend's colour at that opacity (%), 0 for none.
 * Both lines and arrows take the theme's candle colours, as the Tops and Bottoms marks do.
 */

// Exported because the declaration build names it (TS4023) -- see src/indicators/wma.ts.
export interface Ssl {
  [key: string]: number | undefined
  up?: number
  down?: number
  /** +1 long, -1 short; absent before the first close outside the channel. */
  trend?: number
  /** Bars since the trend last flipped, the flip bar being 1; absent before the first flip. */
  age?: number
}

export const SSL_MA = ['SMA', 'EMA', 'WMA', 'VWMA', 'ALMA', 'HMA'] as const
export type SslMa = (typeof SSL_MA)[number]

export interface SslOptions {
  length: number
  ma: SslMa
  shift: number
}

const DEFAULT_LENGTH = 15
const DEFAULT_SHIFT = 0
const DEFAULT_FILL = 12

function countParam(value: unknown, fallback: number, min: number): number {
  // A settings field left blank arrives as undefined.
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback
}

export function sslOptions(calcParams: readonly unknown[]): SslOptions {
  const ma = SSL_MA[countParam(calcParams[1], 0, 0)] ?? 'SMA'
  return {
    length: countParam(calcParams[0], DEFAULT_LENGTH, 1),
    ma,
    shift: countParam(calcParams[2], DEFAULT_SHIFT, 0)
  }
}

// -- the averages -------------------------------------------------------------------------------
//
// Each takes a series that may hold NaN (a bar with no volume, an inner average's warm-up) and
// gives NaN wherever its window holds one, as the port does. SMA and WMA roll their sums forward
// in O(1) per bar, as WMA (wma.ts) does, with a NaN counted rather than summed so it leaves the
// window cleanly; ALMA's weights do not roll, so it sums its window.

function sma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  let sum = 0
  let missing = 0
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i])) sum += x[i]
    else missing++
    if (i >= n) {
      if (Number.isFinite(x[i - n])) sum -= x[i - n]
      else missing--
    }
    if (i >= n - 1 && missing === 0) out[i] = sum / n
  }
  return out
}

// Linearly weighted, the newest bar weighted n. With S the plain sum of the window ending at
// i-1 and W its weighted sum, W(i) = W(i-1) + n * x(i) - S(i-1) (see wma.ts); bars before the
// first count as zeros, which makes the warm-up the same update.
function wma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const norm = (n * (n + 1)) / 2
  let sum = 0
  let weighted = 0
  let missing = 0
  for (let i = 0; i < x.length; i++) {
    const v = Number.isFinite(x[i]) ? x[i] : 0
    if (!Number.isFinite(x[i])) missing++
    weighted += n * v - sum
    sum += v
    if (i >= n) {
      if (Number.isFinite(x[i - n])) sum -= x[i - n]
      else missing--
    }
    if (i >= n - 1 && missing === 0) out[i] = weighted / norm
  }
  return out
}

// Pine's ema: alpha 2/(n+1), seeded with the SMA of the first n values. A NaN is skipped, the
// state carried over it.
function ema(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const alpha = 2 / (n + 1)
  let seed = 0
  let count = 0
  let prev = 0
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue
    if (count < n) {
      seed += x[i]
      count++
      if (count < n) continue
      prev = seed / n
    } else {
      prev = alpha * x[i] + (1 - alpha) * prev
    }
    out[i] = prev
  }
  return out
}

// Pine's alma(src, n, 0.85, 6): Gaussian weights centred 85% of the way to the newest bar.
function alma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const centre = 0.85 * (n - 1)
  const s = n / 6
  const weights = Array.from({ length: n }, (_, k) => Math.exp(-((k - centre) ** 2) / (2 * s * s)))
  const norm = weights.reduce((a, b) => a + b, 0)
  for (let i = n - 1; i < x.length; i++) {
    let acc = 0
    for (let k = 0; k < n; k++) acc += x[i - n + 1 + k] * weights[k] // k = 0 is the oldest bar
    if (Number.isFinite(acc)) out[i] = acc / norm
  }
  return out
}

export function movingAverage(kind: SslMa, x: readonly number[], volume: readonly number[], n: number): number[] {
  switch (kind) {
    case 'SMA':
      return sma(x, n)
    case 'EMA':
      return ema(x, n)
    case 'WMA':
      return wma(x, n)
    case 'VWMA': {
      const weighted = sma(x.map((v, i) => v * volume[i]), n)
      const volumes = sma(volume, n)
      // A window with no volume at all divides zero by zero: no value, not a number.
      return weighted.map((v, i) => v / volumes[i])
    }
    case 'ALMA':
      return alma(x, n)
    case 'HMA': {
      // Pine's `wma(2 * wma(src, len / 2) - wma(src, len), round(sqrt(len)))`, the half floored.
      const half = wma(x, Math.max(1, Math.floor(n / 2)))
      const full = wma(x, n)
      return wma(half.map((v, i) => 2 * v - full[i]), Math.max(1, Math.round(Math.sqrt(n))))
    }
  }
}

function shifted(x: number[], shift: number): number[] {
  return shift === 0 ? x : x.map((_, i) => (i >= shift ? x[i - shift] : Number.NaN))
}

/** The channel over `bars`, one row per bar. */
export function sslChannel(bars: readonly KLineData[], options: SslOptions): Ssl[] {
  const { length, ma, shift } = options
  const volume = bars.map((bar) => (typeof bar.volume === 'number' ? bar.volume : Number.NaN))
  const highs = shifted(movingAverage(ma, bars.map((bar) => bar.high), volume, length), shift)
  const lows = shifted(movingAverage(ma, bars.map((bar) => bar.low), volume, length), shift)

  let trend = 0
  let age: number | undefined
  return bars.map((bar, i) => {
    const high = highs[i]
    const low = lows[i]
    // A comparison with NaN is false, so a bar with no channel holds the trend.
    const next = bar.close > high ? 1 : bar.close < low ? -1 : trend
    if (next !== trend) {
      age = trend === 0 ? undefined : 1
      trend = next
    } else if (age !== undefined) {
      age++
    }
    const row: Ssl = {}
    if (trend === 0) return row
    row.trend = trend
    if (age !== undefined) row.age = age
    if (Number.isFinite(high) && Number.isFinite(low)) {
      row.up = trend > 0 ? high : low
      row.down = trend > 0 ? low : high
    }
    return row
  })
}

// -- drawing ------------------------------------------------------------------------------------

function withAlpha(color: string, alpha: number): string {
  // The theme's candle colours are hex; anything else is drawn as given, through globalAlpha.
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (!hex) return color
  const n = Number.parseInt(hex[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function trendLabel(trend: number | undefined): string {
  return trend === undefined ? '' : trend > 0 ? '▲ long' : '▼ short'
}

const ssl: IndicatorTemplate<Ssl, number> = {
  name: 'SSL',
  shortName: 'SSL',
  series: 'price',
  calcParams: [DEFAULT_LENGTH, 0, DEFAULT_SHIFT, 1, DEFAULT_FILL],
  precision: 5,
  shouldOhlc: false,
  // No `type`: `draw` below is the only rendering, and the legend is built in
  // createTooltipDataSource. As figures they still widen the y-axis to keep both lines in view;
  // `trend` and `age` are deliberately not figures, or their -1..1 and bar counts would too.
  figures: [
    { key: 'up', title: 'Up: ' },
    { key: 'down', title: 'Down: ' }
  ],
  calc: (dataList: KLineData[], indicator) => sslChannel(dataList, sslOptions(indicator.calcParams)),
  createTooltipDataSource: ({ chart, indicator, crosshair }) => {
    const { length, ma, shift } = sslOptions(indicator.calcParams)
    const { upColor, downColor } = chart.getStyles().candle.bar
    const neutral = chart.getStyles().indicator.tooltip.legend.color
    const result = indicator.result
    const row = result[crosshair.dataIndex ?? result.length - 1] ?? {}

    const thousands = chart.getThousandsSeparator()
    const fold = chart.getDecimalFold()
    // What klinecharts' own figure legends show (formatPrecision is toFixed); its `utils` is not
    // imported, because importing klinecharts at runtime needs a window and these templates are
    // tested without one.
    const format = (value: number) => fold.format(thousands.format(value.toFixed(indicator.precision)))
    // The widest text each legend will show over the loaded bars, so the row does not move under
    // the crosshair (the klinecharts patch's `reserve`; figure legends get it for free).
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let oldest = 0
    for (const r of result) {
      for (const v of [r?.up, r?.down]) {
        if (v === undefined) continue
        min = Math.min(min, v)
        max = Math.max(max, v)
      }
      oldest = Math.max(oldest, r?.age ?? 0)
    }
    const priceReserve = min <= max ? [format(min), format(max)].reduce((a, b) => (b.length > a.length ? b : a)) : ''
    const trendText = (r: Ssl) => (r.age === undefined ? trendLabel(r.trend) : `${trendLabel(r.trend)} · ${r.age} bars`)

    const legends: TooltipLegend[] = [
      { title: { text: 'Up: ', color: upColor }, value: { text: row.up === undefined ? 'n/a' : format(row.up), color: upColor, reserve: priceReserve } },
      { title: { text: 'Down: ', color: downColor }, value: { text: row.down === undefined ? 'n/a' : format(row.down), color: downColor, reserve: priceReserve } },
      {
        title: { text: 'Trend: ', color: neutral },
        value: {
          text: row.trend === undefined ? 'n/a' : trendText(row),
          color: row.trend === undefined ? neutral : row.trend > 0 ? upColor : downColor,
          reserve: trendText({ trend: -1, age: oldest > 0 ? oldest : undefined })
        }
      }
    ]
    return {
      name: indicator.shortName,
      calcParamsText: `(${length}, ${ma}, shift ${shift})`,
      legends,
      features: chart.getStyles().indicator.tooltip.features
    }
  },
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    const data = chart.getDataList()
    const result = indicator.result
    const signals = indicator.calcParams[3] !== 0
    const fillParam = indicator.calcParams[4]
    // Absent on a layout saved before the parameter existed: it reads as the default.
    const fill = Math.min(100, countParam(fillParam ?? DEFAULT_FILL, DEFAULT_FILL, 0)) / 100

    const { upColor, downColor } = chart.getStyles().candle.bar
    const barWidth = chart.getBarSpace().bar
    const arrowSize = Math.max(5, Math.min(10, barWidth * 0.8))
    const gap = 3

    const range = chart.getVisibleRange()
    const from = Math.max(0, range.realFrom - 1)
    const to = Math.min(result.length - 1, range.realTo + 1)
    if (to < from) return true

    // The channel: one path per trend, each segment between two bars filled in the colour of the
    // trend it belongs to. A segment the lines cross on is split at the crossing, its left half
    // the old trend's and its right half the new one's.
    if (fill > 0) {
      const long = new Path2D()
      const short = new Path2D()
      for (let i = Math.max(from, 1); i <= to; i++) {
        const a = result[i - 1]
        const b = result[i]
        if (a?.up === undefined || a.down === undefined || b?.up === undefined || b.down === undefined) continue
        const x0 = xAxis.convertToPixel(i - 1)
        const x1 = xAxis.convertToPixel(i)
        const u0 = yAxis.convertToPixel(a.up)
        const d0 = yAxis.convertToPixel(a.down)
        const u1 = yAxis.convertToPixel(b.up)
        const d1 = yAxis.convertToPixel(b.down)
        const path = (trend: number | undefined) => ((trend ?? 0) > 0 ? long : short)
        if (a.trend === b.trend) {
          const p = path(b.trend)
          p.moveTo(x0, u0)
          p.lineTo(x1, u1)
          p.lineTo(x1, d1)
          p.lineTo(x0, d0)
          p.closePath()
          continue
        }
        const gap0 = u0 - d0
        const gap1 = u1 - d1
        const t = gap0 === gap1 ? 0 : gap0 / (gap0 - gap1)
        const xc = x0 + t * (x1 - x0)
        const yc = u0 + t * (u1 - u0)
        const left = path(a.trend)
        left.moveTo(x0, u0)
        left.lineTo(xc, yc)
        left.lineTo(x0, d0)
        left.closePath()
        const right = path(b.trend)
        right.moveTo(xc, yc)
        right.lineTo(x1, u1)
        right.lineTo(x1, d1)
        right.closePath()
      }
      ctx.fillStyle = withAlpha(upColor, fill)
      ctx.fill(long)
      ctx.fillStyle = withAlpha(downColor, fill)
      ctx.fill(short)
    }

    // The two lines, each continuous through a flip, which is what makes them cross.
    const line = (key: 'up' | 'down', color: string) => {
      ctx.beginPath()
      let drawing = false
      for (let i = from; i <= to; i++) {
        const value = result[i]?.[key]
        if (value === undefined) {
          drawing = false
          continue
        }
        const x = xAxis.convertToPixel(i)
        const y = yAxis.convertToPixel(value)
        if (drawing) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
        drawing = true
      }
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      // The canvas arrives with whatever dash was set last -- the dashed last-price line, say.
      ctx.setLineDash([])
      ctx.stroke()
    }
    line('down', downColor)
    line('up', upColor)

    if (signals) {
      for (let i = Math.max(from, 1); i <= to; i++) {
        const before = result[i - 1]?.trend
        const now = result[i]?.trend
        if (before === undefined || now === undefined || before === now) continue
        const x = xAxis.convertToPixel(i)
        const bar = data[i]
        if (now > 0) arrow(ctx, x, yAxis.convertToPixel(bar.low) + gap, arrowSize, false, upColor)
        else arrow(ctx, x, yAxis.convertToPixel(bar.high) - gap, arrowSize, true, downColor)
      }
    }
    return true
  }
}

export default ssl
