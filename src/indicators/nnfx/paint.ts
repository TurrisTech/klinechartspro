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

import type {
  Bounding,
  Chart,
  Indicator,
  IndicatorFigureStyle,
  IndicatorStyle,
  KLineData,
  TooltipLegend,
  XAxis,
  YAxis
} from 'klinecharts'

import { arrow } from '../swing'

// Drawing shared by the NNFX templates. Nothing here imports klinecharts at runtime (it needs a
// window, and the templates are tested without one), so the theme is read from the styles each
// callback is handed rather than through klinecharts' own helpers.

export { arrow }

/** A theme colour at `alpha`. The theme's colours are hex; anything else is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (!hex) return color
  const n = Number.parseInt(hex[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** The colours a sub-pane signal is drawn in: the indicator theme's histogram up/down colours. */
export function signColors(indicator: Pick<Indicator, 'styles'>, defaults?: IndicatorStyle): { up: string; down: string; flat: string } {
  const own = indicator.styles?.bars?.[0]
  const base = defaults?.bars?.[0]
  return {
    up: own?.upColor ?? base?.upColor ?? '#2DC08E',
    down: own?.downColor ?? base?.downColor ?? '#F92855',
    flat: own?.noChangeColor ?? base?.noChangeColor ?? '#888888'
  }
}

/** A line figure's style coloured by the sign of `of(row)`: up above zero, down below. */
export function signLineStyle(sign: number | undefined, indicator: Pick<Indicator, 'styles'>, defaults?: IndicatorStyle): IndicatorFigureStyle {
  const { up, down, flat } = signColors(indicator, defaults)
  return { color: sign === undefined || sign === 0 ? flat : sign > 0 ? up : down }
}

/** The bar indices worth drawing: the visible range and one bar either side, clipped to `n`. */
export function drawRange(chart: Chart, n: number): { from: number; to: number } {
  const range = chart.getVisibleRange()
  return { from: Math.max(0, range.realFrom - 1), to: Math.min(n - 1, range.realTo + 1) }
}

/** A horizontal guide across the pane at `value` -- a zero line, an overbought level. */
export function guide(ctx: CanvasRenderingContext2D, bounding: Bounding, yAxis: YAxis, value: number, color: string, dashed = true): void {
  const y = Math.round(yAxis.convertToPixel(value)) + 0.5
  if (y < 0 || y > bounding.height) return
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash(dashed ? [4, 4] : [])
  ctx.beginPath()
  ctx.moveTo(0, y)
  ctx.lineTo(bounding.width, y)
  ctx.stroke()
  ctx.restore()
}

/** The guides' colour: the legend's text colour, faded. */
export function guideColor(chart: Chart, alpha = 0.45): string {
  return withAlpha(chart.getStyles().indicator.tooltip.legend.color, alpha)
}

/**
 * Shades the area between two series of `rows` -- `a` above `b` in `above`, below it in `below`.
 * A segment the two cross on is split at the crossing, so the colour changes exactly where the
 * lines meet, as a two-lines-cross reads.
 */
export function fillBetween<R extends Record<string, number | undefined>>(
  ctx: CanvasRenderingContext2D,
  xAxis: XAxis,
  yAxis: YAxis,
  rows: readonly R[],
  a: keyof R,
  b: keyof R,
  span: { from: number; to: number },
  above: string,
  below: string
): void {
  const up = new Path2D()
  const down = new Path2D()
  for (let i = Math.max(span.from, 1); i <= span.to; i++) {
    const a0 = rows[i - 1]?.[a]
    const b0 = rows[i - 1]?.[b]
    const a1 = rows[i]?.[a]
    const b1 = rows[i]?.[b]
    if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined) continue
    const x0 = xAxis.convertToPixel(i - 1)
    const x1 = xAxis.convertToPixel(i)
    const ya0 = yAxis.convertToPixel(a0)
    const yb0 = yAxis.convertToPixel(b0)
    const ya1 = yAxis.convertToPixel(a1)
    const yb1 = yAxis.convertToPixel(b1)
    const gap0 = a0 - b0
    const gap1 = a1 - b1
    if (gap0 >= 0 === gap1 >= 0) {
      const p = gap1 >= 0 ? up : down
      p.moveTo(x0, ya0)
      p.lineTo(x1, ya1)
      p.lineTo(x1, yb1)
      p.lineTo(x0, yb0)
      p.closePath()
      continue
    }
    const t = gap0 / (gap0 - gap1)
    const xc = x0 + t * (x1 - x0)
    const yc = ya0 + t * (ya1 - ya0)
    const left = gap0 >= 0 ? up : down
    left.moveTo(x0, ya0)
    left.lineTo(xc, yc)
    left.lineTo(x0, yb0)
    left.closePath()
    const right = gap1 >= 0 ? up : down
    right.moveTo(xc, yc)
    right.lineTo(x1, ya1)
    right.lineTo(x1, yb1)
    right.closePath()
  }
  ctx.fillStyle = above
  ctx.fill(up)
  ctx.fillStyle = below
  ctx.fill(down)
}

/** An arrow's size for the current zoom, as the Tops and Bottoms marks size theirs. */
export function arrowSize(chart: Chart): number {
  return Math.max(5, Math.min(10, chart.getBarSpace().bar * 0.8))
}

/**
 * Arrows on the price pane for each bar whose `trend` differs from the bar before's: up below the
 * bar's low on a turn long, down above its high on a turn short.
 */
export function flipArrows(
  ctx: CanvasRenderingContext2D,
  chart: Chart,
  xAxis: XAxis,
  yAxis: YAxis,
  trends: ReadonlyArray<number | undefined>,
  span: { from: number; to: number },
  colors: { up: string; down: string }
): void {
  const data: KLineData[] = chart.getDataList()
  const size = arrowSize(chart)
  const gap = 3
  for (let i = Math.max(span.from, 1); i <= span.to; i++) {
    const before = trends[i - 1]
    const now = trends[i]
    if (before === undefined || now === undefined || before === now || now === 0) continue
    const bar = data[i]
    if (bar === undefined) continue
    const x = xAxis.convertToPixel(i)
    if (now > 0) arrow(ctx, x, yAxis.convertToPixel(bar.low) + gap, size, false, colors.up)
    else arrow(ctx, x, yAxis.convertToPixel(bar.high) - gap, size, true, colors.down)
  }
}

/**
 * A price-pane template's legends, for the templates that draw themselves (their figures carry no
 * `type`, so klinecharts builds none). Values are formatted as klinecharts' own figure legends
 * are, and each reserves the widest text it shows over the loaded bars so the row does not move
 * under the crosshair (the klinecharts patch's `reserve`).
 */
export function priceLegends<R extends Record<string, number | undefined>>(
  chart: Chart,
  indicator: Pick<Indicator<R>, 'result' | 'precision'>,
  row: R,
  items: ReadonlyArray<{ key: keyof R; title: string; color: string }>
): TooltipLegend[] {
  const thousands = chart.getThousandsSeparator()
  const fold = chart.getDecimalFold()
  const format = (v: number) => fold.format(thousands.format(v.toFixed(indicator.precision)))
  return items.map(({ key, title, color }) => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const r of indicator.result) {
      const v = r?.[key]
      if (v === undefined) continue
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    const reserve = min <= max ? [format(min), format(max)].reduce((p, q) => (q.length > p.length ? q : p)) : ''
    const v = row[key]
    return { title: { text: title, color }, value: { text: v === undefined ? 'n/a' : format(v), color, reserve } }
  })
}

/** The legend's text for a trend state and how long it has held. */
export function trendText(trend: number | undefined, age?: number): string {
  if (trend === undefined || trend === 0) return 'n/a'
  const side = trend > 0 ? '▲ long' : '▼ short'
  return age === undefined ? side : `${side} · ${age} bars`
}

/** How many bars each row's `trend` has held, the turning bar being 1; absent before the first turn. */
export function trendAges(trends: ReadonlyArray<number | undefined>): Array<number | undefined> {
  let age: number | undefined
  let prev: number | undefined
  return trends.map((t) => {
    if (t === undefined || t === 0) {
      prev = t
      age = undefined
      return undefined
    }
    if (prev === undefined || prev === 0) age = undefined
    else if (t !== prev) age = 1
    else if (age !== undefined) age++
    prev = t
    return age
  })
}
