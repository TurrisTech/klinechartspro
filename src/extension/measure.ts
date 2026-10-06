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

import { type Chart, type Coordinate, type OverlayFigure, type OverlayTemplate, utils } from 'klinecharts'

import type { SymbolInfo } from '../types'
import { FILL_ALPHA, measureReadout, withAlpha } from './measureReadout'

// The price pane's ruler: Shift + drag measures from the point pressed to the point released
// (ChartPane.svelte drives it; nothing in the drawing bar creates one). A box between the two
// points, shaded in the direction's candle colour, an arrow along each side, and a label with
// the move -- price, percent, pips where the instrument has them -- and the bars and time it
// spans. Every figure ignores events: a measurement can be neither selected, dragged nor
// right-click deleted, and it never stands between a click and the candles under it.

export const MEASURE_OVERLAY = 'measure'

const FONT_SIZE = 12
const LINE_HEIGHT = 16
const PAD_X = 8
const PAD_Y = 5
const LABEL_GAP = 6
const EDGE = 2
const ARROW = 6

function arrowhead(tip: Coordinate, from: Coordinate): Coordinate[] {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x)
  const wing = (turn: number): Coordinate => ({
    x: tip.x - ARROW * Math.cos(angle + turn),
    y: tip.y - ARROW * Math.sin(angle + turn)
  })
  return [wing(Math.PI / 6), tip, wing(-Math.PI / 6)]
}

/** A line from `from` to `to`, with a head at `to` once it is long enough to carry one. */
function arrow(from: Coordinate, to: Coordinate, color: string): OverlayFigure[] {
  const style = { style: 'solid', size: 1, color, dashedValue: [] }
  const figures: OverlayFigure[] = [
    { type: 'line', attrs: { coordinates: [from, to] }, styles: style, ignoreEvent: true }
  ]
  if (Math.hypot(to.x - from.x, to.y - from.y) > ARROW * 2) {
    figures.push({ type: 'line', attrs: { coordinates: arrowhead(to, from) }, styles: style, ignoreEvent: true })
  }
  return figures
}

function directionColor(chart: Chart, up: boolean): string {
  const bar = chart.getStyles().candle.bar
  return up ? bar.upColor : bar.downColor
}

const measure: OverlayTemplate = {
  name: MEASURE_OVERLAY,
  totalStep: 3,
  lock: true,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ chart, overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return []
    const [a, b] = coordinates
    const [p0, p1] = overlay.points
    if (typeof p0?.value !== 'number' || typeof p1?.value !== 'number') return []
    const symbol = chart.getSymbol() as (SymbolInfo & { pricePrecision: number }) | null
    const barSpace = chart.getBarSpace().bar
    const readout = measureReadout({
      from: p0.value,
      to: p1.value,
      bars: barSpace > 0 ? (b.x - a.x) / barSpace : 0,
      spanMs: typeof p0.timestamp === 'number' && typeof p1.timestamp === 'number' ? p1.timestamp - p0.timestamp : 0,
      precision: symbol?.pricePrecision ?? 2,
      pipSize: symbol?.pipSize
    })
    const color = directionColor(chart, readout.up)

    const left = Math.min(a.x, b.x)
    const top = Math.min(a.y, b.y)
    const width = Math.abs(b.x - a.x)
    const height = Math.abs(b.y - a.y)
    const midX = (a.x + b.x) / 2
    const midY = (a.y + b.y) / 2

    const family = chart.getStyles().overlay.text.family
    const lines = [readout.move, readout.span]
    const labelWidth = Math.max(...lines.map((line) => utils.calcTextWidth(line, FONT_SIZE, 'normal', family))) + PAD_X * 2
    const labelHeight = lines.length * LINE_HEIGHT + PAD_Y * 2
    const clamp = (value: number, max: number) => Math.max(EDGE, Math.min(value, max))
    const above = top - LABEL_GAP - labelHeight
    const below = top + height + LABEL_GAP
    // Beyond the end the move went towards, as a ruler reads; on the other side when that
    // would leave the pane, and inside it as a last resort.
    const labelY = readout.up
      ? (above >= EDGE ? above : below)
      : (below + labelHeight <= bounding.height - EDGE ? below : above)
    const labelLeft = clamp(midX - labelWidth / 2, bounding.width - labelWidth - EDGE)
    const labelTop = clamp(labelY, bounding.height - labelHeight - EDGE)

    return [
      {
        type: 'rect',
        attrs: { x: left, y: top, width, height },
        styles: { style: 'fill', color: withAlpha(color, FILL_ALPHA) },
        ignoreEvent: true
      },
      ...arrow({ x: midX, y: a.y }, { x: midX, y: b.y }, color),
      ...arrow({ x: a.x, y: midY }, { x: b.x, y: midY }, color),
      {
        type: 'rect',
        attrs: { x: labelLeft, y: labelTop, width: labelWidth, height: labelHeight },
        styles: { style: 'fill', color, borderRadius: 4 },
        ignoreEvent: true
      },
      {
        type: 'text',
        attrs: lines.map((text, index) => ({
          x: labelLeft + labelWidth / 2,
          y: labelTop + PAD_Y + index * LINE_HEIGHT + (LINE_HEIGHT - FONT_SIZE) / 2,
          text,
          align: 'center',
          baseline: 'top'
        })),
        styles: {
          color: '#ffffff',
          size: FONT_SIZE,
          family,
          weight: 'normal',
          backgroundColor: 'transparent',
          borderSize: 0,
          paddingLeft: 0,
          paddingRight: 0,
          paddingTop: 0,
          paddingBottom: 0
        },
        ignoreEvent: true
      }
    ]
  },
  // The two prices on the axis, with the band between them -- always, where klinecharts'
  // default axis figures appear only while an overlay is selected, which this one never is.
  createYAxisFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length < 2) return []
    const [p0, p1] = overlay.points
    if (typeof p0?.value !== 'number' || typeof p1?.value !== 'number') return []
    const color = directionColor(chart, p1.value >= p0.value)
    const precision = (chart.getSymbol()?.pricePrecision as number | undefined) ?? 2
    const fromZero = yAxis?.isFromZero() ?? false
    const top = Math.min(coordinates[0].y, coordinates[1].y)
    const height = Math.abs(coordinates[1].y - coordinates[0].y)
    return [
      {
        type: 'rect',
        attrs: { x: 0, y: top, width: bounding.width, height },
        styles: { style: 'fill', color: withAlpha(color, FILL_ALPHA) },
        ignoreEvent: true
      },
      {
        type: 'text',
        attrs: [p0.value, p1.value].map((value, index) => ({
          x: fromZero ? 0 : bounding.width,
          y: coordinates[index].y,
          text: utils.formatPrecision(value, precision),
          align: fromZero ? 'left' : 'right',
          baseline: 'middle'
        })),
        styles: {
          color: '#ffffff',
          size: FONT_SIZE,
          backgroundColor: color,
          borderSize: 0,
          borderRadius: 2,
          paddingLeft: 4,
          paddingRight: 4,
          paddingTop: 2,
          paddingBottom: 2
        },
        ignoreEvent: true
      }
    ]
  }
}

export default measure
