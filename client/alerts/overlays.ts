import type { Chart, Overlay, OverlayCreate } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { symbolVendor } from '../symbols'
import { ALERT_OVERLAY_NAME, type AlertOverlayData, registerAlertOverlay } from './template'
import { instrumentKey, type PriceAlert } from './types'

// Every alert line on every pane of the wall, and the two gestures they answer: a DRAG (which
// the caller turns into the edit dialog) and a right-click (which the caller turns into the
// alert's own menu).
//
// Modelled on client/trading/overlays.ts, and for the same reasons: overlays carry a
// `groupId` so a pane's whole set can be removed and rebuilt from one snapshot, and each pane
// draws only its own instrument. What is different is the template — `wdPriceAlert`
// (template.ts) rather than a built-in — because the price tag on the axis has to be there
// whether or not the line is selected.

const GROUP = 'wd-alert'
const CANDLE_PANE = 'candle_pane'

/** How close to a line a right-click has to land to be about THAT alert rather than about
 * creating one. Generous enough to hit a 1px line with a mouse, tight enough that two alerts
 * a few pips apart on a zoomed-in pane are still separable. */
const HIT_TOLERANCE_PX = 6

export interface AlertColors {
  armed: string
  triggered: string
  label: string
}

export const DEFAULT_ALERT_COLORS: AlertColors = {
  // Orange: the same colour the Notification Center's bell blinks in, so an alert on the
  // chart and the notification it will raise read as one thing.
  armed: '#ff9800',
  triggered: '#787b86',
  label: '#ff9800'
}

export interface AlertOverlayHandlers {
  /** A line was dropped at `price`. Nothing is committed yet — the caller opens the dialog,
   * and calls back into `update` whatever the user decides (which is what puts a cancelled
   * drag back where it was). */
  onDragEnd(alert: PriceAlert, price: number): void
}

function overlayFor(alert: PriceAlert, anchor: number, colors: AlertColors): OverlayCreate {
  const color = alert.status === 'armed' ? colors.armed : colors.triggered
  const data: AlertOverlayData = {
    wd: {
      id: alert.id,
      status: alert.status,
      label: alert.note ?? ''
    }
  }
  return {
    name: ALERT_OVERLAY_NAME,
    paneId: CANDLE_PANE,
    // Draggable in both states. Dragging a triggered alert is how it is re-armed somewhere
    // else, which is the same gesture as moving a live one and should not need a different
    // one.
    lock: false,
    extendData: data,
    styles: {
      line: { color, size: alert.status === 'armed' ? 1 : 1, style: 'dashed' },
      text: {
        color: '#ffffff',
        backgroundColor: color,
        size: 11,
        paddingLeft: 4,
        paddingRight: 4,
        paddingTop: 2,
        paddingBottom: 2,
        borderRadius: 2
      }
    },
    // A single point: the template's line spans the pane whatever x it is given, and the
    // anchor only has to be a timestamp the chart knows, so the point converts to a
    // coordinate at all.
    points: [{ timestamp: anchor, value: alert.price }]
  }
}

/** The timestamp an alert's single point is anchored to. The oldest loaded bar rather than
 * the newest: the newest moves on every tick, which would rewrite every overlay's point on
 * every frame for no visible difference. */
function anchorTimestamp(chart: Chart): number | null {
  const data = chart.getDataList()
  return data.length === 0 ? null : data[0].timestamp
}

export class AlertOverlays {
  private readonly panes = new Map<string, { pane: ChartProPane; chart: Chart }>()
  private alerts: PriceAlert[] = []

  constructor(
    private readonly handlers: AlertOverlayHandlers,
    private readonly colors: AlertColors = DEFAULT_ALERT_COLORS
  ) {
    registerAlertOverlay()
  }

  /** Called from the wall's onPanesChange, exactly like a ChartLayer's sync. */
  sync(panes: ChartProPane[]): void {
    const live = new Set(panes.map((pane) => pane.id))
    for (const [id, entry] of this.panes) {
      if (live.has(id)) continue
      this.clear(entry.chart)
      this.panes.delete(id)
    }
    for (const pane of panes) {
      if (this.panes.has(pane.id)) continue
      const chart = pane.getChart()
      if (!chart) continue
      const entry = { pane, chart }
      this.panes.set(pane.id, entry)
      // The anchor is the oldest loaded bar, so a history page-in moves it -- without this a
      // pane that scrolled back would keep an anchor the chart no longer knows.
      chart.subscribeAction('onVisibleRangeChange', () => this.redraw(entry))
      this.redraw(entry)
    }
  }

  update(alerts: PriceAlert[]): void {
    this.alerts = alerts
    for (const entry of this.panes.values()) this.redraw(entry)
  }

  /** The alert whose line is within `HIT_TOLERANCE_PX` of `y` (pane-local pixels) on this
   * pane, nearest first. Null when the click was on empty chart. */
  alertAt(paneId: string, y: number): PriceAlert | null {
    const entry = this.panes.get(paneId)
    if (!entry) return null
    let best: { alert: PriceAlert; distance: number } | null = null
    for (const alert of this.alertsFor(entry.pane)) {
      const coordinate = entry.chart.convertToPixel({ value: alert.price }, { paneId: CANDLE_PANE })
      const py = Array.isArray(coordinate) ? coordinate[0]?.y : coordinate.y
      if (typeof py !== 'number') continue
      const distance = Math.abs(py - y)
      if (distance > HIT_TOLERANCE_PX) continue
      if (!best || distance < best.distance) best = { alert, distance }
    }
    return best?.alert ?? null
  }

  teardown(): void {
    for (const entry of this.panes.values()) this.clear(entry.chart)
    this.panes.clear()
  }

  private alertsFor(pane: ChartProPane): PriceAlert[] {
    const symbol = pane.getSymbol()
    const key = instrumentKey(symbolVendor(symbol), symbol.ticker)
    return this.alerts.filter((alert) => instrumentKey(alert.vendor, alert.symbol) === key)
  }

  private clear(chart: Chart): void {
    try {
      chart.removeOverlay({ groupId: GROUP })
    } catch {
      // chart disposed
    }
  }

  private redraw(entry: { pane: ChartProPane; chart: Chart }): void {
    const { pane, chart } = entry
    this.clear(chart)
    const anchor = anchorTimestamp(chart)
    if (anchor === null) return
    for (const alert of this.alertsFor(pane)) {
      const created = overlayFor(alert, anchor, this.colors) as OverlayCreate & {
        groupId: string
        onPressedMoveEnd?: (event: { overlay: Overlay }) => boolean
        onRightClick?: (event: { overlay: Overlay; preventDefault?: () => void }) => boolean
      }
      created.groupId = GROUP
      created.onPressedMoveEnd = (event) => {
        const price = event.overlay.points?.[0]?.value
        if (typeof price === 'number') this.handlers.onDragEnd(alert, price)
        return false
      }
      // klinecharts REMOVES an overlay on right-click unless the handler prevents the
      // default (OverlayView._figureMouseRightClickEvent). The menu itself is opened from
      // the pane's own `contextmenu` listener -- which fires for a click on empty chart too,
      // so there is one code path for "create here" and "this alert" -- but without this the
      // line would vanish from the canvas on the way there.
      created.onRightClick = (event) => {
        event.preventDefault?.()
        return true
      }
      try {
        chart.createOverlay(created)
      } catch (err) {
        console.warn('[alerts] overlay create failed', err)
      }
    }
  }
}
