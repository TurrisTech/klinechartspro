import { registerOverlay } from 'klinecharts'
import type { OverlayFigure, OverlayTemplate } from 'klinecharts'
import { withAlpha } from '../color'

// The two chart figures of a price alert, as registered templates: the BELL at the right edge
// of the pane on an enabled line -- a pill that says beside it whether the alert is once (1) or
// every time (a repeat arrow), and strikes it through when switched off -- and the alert ZONE
// band drawn while a line is hovered or its alert is being edited. Templates rather than built-ins because both are placed against
// the pane's own bounds -- the bell hard against the right edge whatever the bars, the band
// across the whole width -- which only `createPointFigures` sees.
//
// One point each, at a bar the chart holds, so it converts to a coordinate at all; only its
// `y` is read.

export const PRICE_ALERT_ICON = 'wdPriceAlert'
export const PRICE_ALERT_ZONE = 'wdPriceAlertZone'

/** The bell's badge -- a pill, ICON_WIDTH x ICON_SIZE -- and its gap from the pane's right edge,
 * in px. The editor is anchored from the right edge (view.ts), the zone's caption from the width. */
export const ICON_SIZE = 16
export const ICON_WIDTH = 30
export const ICON_INSET = 4

/** What the pill says beside its bell: how the alert is armed. `once` is a 1, `always` (every
 * time) a repeat arrow, and `off` (switched off) a struck-through bell with nothing beside it. */
export type BellMark = 'once' | 'always' | 'off'

// A bell in a 10 x 10 box: the body, then the clapper.
const BELL =
  'M5 0.6C3.3 0.6 2.2 1.9 2.2 3.6V6.1L1 7.6V8.2H9V7.6L7.8 6.1V3.6C7.8 1.9 6.7 0.6 5 0.6Z' +
  'M3.9 8.8H6.1C6.1 9.5 5.6 10 5 10C4.4 10 3.9 9.5 3.9 8.8Z'

// The strike through a switched-off bell, corner to corner of its 10 x 10 box.
const STRIKE = 'M0.5 0.5L9.5 9.5'

// A 1 in a 10 x 10 box: the stem, the flag, the foot.
const ONE = 'M4.4 0.4H6.2V8.4H7.8V10H2.8V8.4H4.4V2.7L2.8 3.6V1.7Z'

// A repeat arrow in a 10 x 10 box: three quarters of a circle run clockwise from the top right
// round to the top left (stroked), and the head at its end pointing on round (filled).
const LOOP = 'M7 1.6A3.9 3.9 0 1 1 2.9 1.7'
const LOOP_HEAD = 'M4.6 0.6L3.5 3.2L1.8 0.5Z'

/** The overlay's styles for a pill of `color` saying `mark`. Both ride in `styles`, which is what
 * puts them in the layer's paint signature (chartlayers/paint.ts) -- `extendData` is not -- so an
 * alert going from once to every time repaints though its colour does not change. */
export function bellStyles(color: string, mark: BellMark): { rect: { color: string }; bellMark: BellMark } {
  return { rect: { color }, bellMark: mark }
}

function badgeColor(styles: unknown): string {
  const rect = (styles as { rect?: { color?: unknown } } | null | undefined)?.rect
  return typeof rect?.color === 'string' ? rect.color : '#ff9800'
}

function bellMark(styles: unknown): BellMark {
  const mark = (styles as { bellMark?: unknown } | null | undefined)?.bellMark
  return mark === 'once' || mark === 'off' ? mark : 'always'
}

/** The figures inside the pill whose left edge is `x` and middle `y`: none of them takes the
 * pointer, which is the pill's. */
function markFigures(mark: BellMark, x: number, y: number): OverlayFigure[] {
  const white = '#ffffff'
  if (mark === 'off') {
    const left = x + (ICON_WIDTH - 10) / 2
    return [
      { type: 'path', attrs: { x: left, y: y - 5, path: BELL }, styles: { style: 'fill', color: white }, ignoreEvent: true },
      {
        type: 'path',
        attrs: { x: left, y: y - 5, path: STRIKE },
        styles: { style: 'stroke', color: white, lineWidth: 1.4 },
        ignoreEvent: true
      }
    ]
  }
  const bell: OverlayFigure = {
    type: 'path',
    attrs: { x: x + 4, y: y - 5, path: BELL },
    styles: { style: 'fill', color: white },
    ignoreEvent: true
  }
  const right = x + 16
  if (mark === 'once') {
    return [bell, { type: 'path', attrs: { x: right, y: y - 5, path: ONE }, styles: { style: 'fill', color: white }, ignoreEvent: true }]
  }
  return [
    bell,
    {
      type: 'path',
      attrs: { x: right, y: y - 5, path: LOOP },
      styles: { style: 'stroke', color: white, lineWidth: 1.5 },
      ignoreEvent: true
    },
    { type: 'path', attrs: { x: right, y: y - 5, path: LOOP_HEAD }, styles: { style: 'fill', color: white }, ignoreEvent: true }
  ]
}

/** The pill on a pane `width` wide, its middle at `y`: hard against the right edge, inset by
 * ICON_INSET. Its body is the hit target -- clicking it opens the alert, hovering it shows the
 * zone -- and nothing drawn on it takes the pointer. */
export function bellFigures(styles: unknown, width: number, y: number): OverlayFigure[] {
  const x = width - ICON_INSET - ICON_WIDTH
  return [
    {
      type: 'rect',
      attrs: { x, y: y - ICON_SIZE / 2, width: ICON_WIDTH, height: ICON_SIZE },
      styles: { style: 'fill', color: badgeColor(styles), borderRadius: ICON_SIZE / 2 }
    },
    ...markFigures(bellMark(styles), x, y)
  ]
}

const icon: OverlayTemplate = {
  name: PRICE_ALERT_ICON,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding }) =>
    coordinates.length === 0 ? [] : bellFigures(overlay.styles, bounding.width, coordinates[0].y)
}

/** What the band draws: its two edges in price, the caption, and whether it is the zone a
 * click WOULD make (fainter) or an alert's own. */
export interface ZoneFigureData {
  low: number
  high: number
  label: string
  color: string
  preview: boolean
}

const zone: OverlayTemplate<ZoneFigureData> = {
  name: PRICE_ALERT_ZONE,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, bounding, yAxis }) => {
    const data = overlay.extendData
    if (!data || !yAxis) return []
    const top = Math.min(yAxis.convertToPixel(data.high), yAxis.convertToPixel(data.low))
    const bottom = Math.max(yAxis.convertToPixel(data.high), yAxis.convertToPixel(data.low))
    const edge = withAlpha(data.color, data.preview ? 0.55 : 0.9)
    // Nothing here takes the pointer: the band sits over the line being hovered, and taking
    // the pointer from it would end the hover that drew the band.
    const figures: OverlayFigure[] = []
    if (bottom - top >= 1) {
      figures.push({
        type: 'rect',
        attrs: { x: 0, y: top, width: bounding.width, height: bottom - top },
        styles: { style: 'fill', color: withAlpha(data.color, data.preview ? 0.07 : 0.14) },
        ignoreEvent: true
      })
      for (const y of [top, bottom]) {
        figures.push({
          type: 'line',
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: { style: 'dashed', color: edge, size: 1, dashedValue: [4, 3] },
          ignoreEvent: true
        })
      }
    }
    figures.push({
      type: 'text',
      // Above the band and left of the bell, so neither covers the other.
      attrs: {
        x: bounding.width - ICON_INSET - ICON_WIDTH - 6,
        y: top - 3,
        text: data.label,
        align: 'right',
        baseline: 'bottom'
      },
      styles: {
        color: '#ffffff',
        backgroundColor: edge,
        size: 11,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 2,
        paddingBottom: 2,
        borderRadius: 2
      },
      ignoreEvent: true
    })
    return figures
  }
}

let registered = false

/** Idempotent: klinecharts' registry is process-global and every wall mount builds a view. */
export function registerPriceAlertFigures(): void {
  if (registered) return
  registered = true
  registerOverlay(icon)
  registerOverlay(zone as OverlayTemplate)
}
