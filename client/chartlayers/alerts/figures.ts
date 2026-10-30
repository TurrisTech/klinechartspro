import { registerOverlay } from 'klinecharts'
import type { OverlayFigure, OverlayTemplate } from 'klinecharts'
import { withAlpha } from '../color'

// The two chart figures of a price alert, as registered templates: the BELL at the right edge
// of the pane on an enabled line, and the alert ZONE band drawn while a line is hovered or its
// alert is being edited. Templates rather than built-ins because both are placed against
// the pane's own bounds -- the bell hard against the right edge whatever the bars, the band
// across the whole width -- which only `createPointFigures` sees.
//
// One point each, at a bar the chart holds, so it converts to a coordinate at all; only its
// `y` is read.

export const PRICE_ALERT_ICON = 'wdPriceAlert'
export const PRICE_ALERT_ZONE = 'wdPriceAlertZone'

/** The bell's badge, and its gap from the pane's right edge, in px. The editor is anchored
 * from the same two numbers (view.ts). */
export const ICON_SIZE = 16
export const ICON_INSET = 4

// A bell in a 10 x 10 box: the body, then the clapper.
const BELL =
  'M5 0.6C3.3 0.6 2.2 1.9 2.2 3.6V6.1L1 7.6V8.2H9V7.6L7.8 6.1V3.6C7.8 1.9 6.7 0.6 5 0.6Z' +
  'M3.9 8.8H6.1C6.1 9.5 5.6 10 5 10C4.4 10 3.9 9.5 3.9 8.8Z'

/** The badge colour rides in the overlay's `styles.rect`, which is what puts it in the
 * layer's paint signature (chartlayers/paint.ts) -- `extendData` is not. */
function badgeColor(styles: unknown): string {
  const rect = (styles as { rect?: { color?: unknown } } | null | undefined)?.rect
  return typeof rect?.color === 'string' ? rect.color : '#ff9800'
}

const icon: OverlayTemplate = {
  name: PRICE_ALERT_ICON,
  totalStep: 2,
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    if (coordinates.length === 0) return []
    const y = coordinates[0].y
    const x = bounding.width - ICON_INSET - ICON_SIZE
    return [
      // The badge is the hit target: clicking it opens the alert, hovering it shows the zone.
      {
        type: 'rect',
        attrs: { x, y: y - ICON_SIZE / 2, width: ICON_SIZE, height: ICON_SIZE },
        styles: { style: 'fill', color: badgeColor(overlay.styles), borderRadius: 3 }
      },
      {
        type: 'path',
        attrs: { x: x + 3, y: y - 5, path: BELL },
        styles: { style: 'fill', color: '#ffffff' },
        ignoreEvent: true
      }
    ]
  }
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
        x: bounding.width - ICON_INSET - ICON_SIZE - 6,
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
