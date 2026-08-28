import { registerOverlay, utils } from 'klinecharts'
import type { OverlayFigure, OverlayTemplate } from 'klinecharts'
import type { WatchStatus } from './types'

// The chart figure a price watch IS: one horizontal line across the pane, and a persistent
// price tag on the price axis.
//
// It has to be a REGISTERED template rather than a built-in with per-instance overrides,
// because of one klinecharts detail: `OverlayCreate` omits `createYAxisFigures`, and the
// DEFAULT axis figure (`needDefaultYAxisFigure`) is drawn only while the overlay is the
// selected one (OverlayYAxisView.getDefaultFigures checks `clickOverlayInfo`). A tag that
// appears only when you click the line is not "the price tagged on the price axis", so the
// axis figure is supplied here — the same way klinecharts' own `simpleTag` does it, which is
// the closest built-in and is not draggable.
//
// Draggable comes for free and deliberately: the line figure carries events (no
// `ignoreEvent`), so pressing it routes to `eventPressedOtherMove`, which applies the
// pointer's delta to the point's value. `onPressedMoveEnd` on the instance is what
// client/watch/overlays.ts turns into the edit dialog.

export const WATCH_OVERLAY_NAME = 'wdPriceWatch'

/** What one watch overlay carries. The controller reads it back on every event. */
export interface WatchOverlayData {
  wd: {
    id: string
    status: WatchStatus
    /** Drawn beside the line. The watch's note, or empty. */
    label: string
  }
}

function datumOf(extendData: unknown): WatchOverlayData['wd'] | null {
  const data = extendData as WatchOverlayData | undefined
  return data?.wd ?? null
}

/** The axis tag reads the instrument's own display precision, exactly as the axis ticks and
 * the crosshair do — a level of 1.16500 must not render as 1.165. */
function priceText(precision: number, value: number): string {
  return utils.formatPrecision(value, precision)
}

const template: OverlayTemplate<WatchOverlayData> = {
  name: WATCH_OVERLAY_NAME,
  // One point, placed programmatically: these are never drawn by hand from the drawing bar,
  // so `totalStep: 2` (one click) is only ever reached through `createOverlay`.
  totalStep: 2,
  // No handle circles. The line itself is the drag target, and a permanent dot on every
  // line would read as a chart artefact rather than as a control.
  needDefaultPointFigure: false,
  needDefaultXAxisFigure: false,
  needDefaultYAxisFigure: false,
  styles: {
    line: { style: 'dashed' }
  },
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    if (coordinates.length === 0) return []
    const y = coordinates[0].y
    const figures: OverlayFigure[] = [
      {
        type: 'line',
        attrs: {
          coordinates: [
            { x: 0, y },
            { x: bounding.width, y }
          ]
        }
      }
    ]
    const datum = datumOf(overlay.extendData)
    if (datum && datum.label !== '') {
      figures.push({
        type: 'text',
        // Above the line and hard against the left edge, so it never collides with the axis
        // tag and never moves as the pane is panned.
        attrs: { x: 6, y: y - 3, text: datum.label, align: 'left', baseline: 'bottom' },
        ignoreEvent: true
      })
    }
    return figures
  },
  createYAxisFigures: ({ chart, overlay, coordinates, bounding, yAxis }) => {
    if (coordinates.length === 0) return []
    const value = overlay.points[0]?.value
    if (typeof value !== 'number') return []
    // The axis can be drawn on either side; `isFromZero` is klinecharts' own test for it and
    // is what its built-in tags branch on.
    const fromZero = yAxis?.isFromZero() ?? false
    const precision = chart.getSymbol()?.pricePrecision ?? 5
    return {
      type: 'text',
      attrs: {
        x: fromZero ? 0 : bounding.width,
        y: coordinates[0].y,
        text: priceText(precision, value),
        align: fromZero ? 'left' : 'right',
        baseline: 'middle'
      },
      ignoreEvent: true
    }
  }
}

let registered = false

/** Idempotent: every wall mount calls it, and klinecharts' registry is process-global. */
export function registerWatchOverlay(): void {
  if (registered) return
  registered = true
  registerOverlay(template)
}
