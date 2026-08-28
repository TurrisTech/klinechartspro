import type { Chart, Overlay, OverlayCreate } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { symbolVendor } from '../symbols'
import { registerWatchOverlay, WATCH_OVERLAY_NAME, type WatchOverlayData } from './template'
import { instrumentTarget, priceLevel, type Watch } from './types'

// Every price-watch line on every pane of the wall, and the two gestures they answer: a DRAG
// (which the caller turns into the edit dialog) and a right-click (which the caller turns
// into the watch's own menu).
//
// Modelled on client/trading/overlays.ts: overlays carry a `groupId` so a pane's whole set
// can be removed and rebuilt from one snapshot, and each pane draws only its own instrument.
// What is different is the template -- `wdPriceWatch` (template.ts) rather than a built-in --
// because the price tag on the axis has to be there whether or not the line is selected.
//
// Only a plain price level gets a line. A watch on a bar's close, a combinator, or a
// third-party source is a perfectly good watch with no price to draw it at, and `priceLevel`
// returning null is how it is skipped rather than guessed at.

const GROUP = 'wd-watch'
const CANDLE_PANE = 'candle_pane'

/** How close to a line a right-click has to land to be about THAT watch rather than about
 * creating one. Generous enough to hit a 1px line with a mouse, tight enough that two levels
 * a few pips apart on a zoomed-in pane are still separable. */
const HIT_TOLERANCE_PX = 6

export interface WatchColors {
  armed: string
  fired: string
  disabled: string
}

export const DEFAULT_WATCH_COLORS: WatchColors = {
  // Orange: the same colour the Notification Center's bell blinks in, so a line on the chart
  // and the notification it will raise read as one thing.
  armed: '#ff9800',
  fired: '#787b86',
  disabled: '#4a4d57'
}

export interface WatchOverlayHandlers {
  /** A line was dropped at `price`. Nothing is committed yet -- the caller opens the dialog,
   * and the store re-emits whatever the user decides (which is what puts a cancelled drag
   * back where it was). */
  onDragEnd(watch: Watch, price: number): void
}

function colorFor(watch: Watch, colors: WatchColors): string {
  if (!watch.enabled || watch.status === 'disabled') return colors.disabled
  return watch.status === 'fired' ? colors.fired : colors.armed
}

function overlayFor(watch: Watch, level: number, anchor: number, colors: WatchColors): OverlayCreate {
  const color = colorFor(watch, colors)
  const data: WatchOverlayData = {
    wd: { id: watch.id, status: watch.status, label: watch.note ?? '' }
  }
  return {
    name: WATCH_OVERLAY_NAME,
    paneId: CANDLE_PANE,
    // Draggable in every state. Dragging a fired watch is how it is re-armed somewhere else,
    // which is the same gesture as moving a live one and should not need a different one.
    lock: false,
    extendData: data,
    styles: {
      line: { color, size: 1, style: 'dashed' },
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
    points: [{ timestamp: anchor, value: level }]
  }
}

/** The timestamp a line's single point is anchored to. The oldest loaded bar rather than the
 * newest: the newest moves on every tick, which would rewrite every overlay's point on every
 * frame for no visible difference. */
function anchorTimestamp(chart: Chart): number | null {
  const data = chart.getDataList()
  return data.length === 0 ? null : data[0].timestamp
}

export class WatchOverlays {
  private readonly panes = new Map<string, { pane: ChartProPane; chart: Chart }>()
  private watches: Watch[] = []

  constructor(
    private readonly handlers: WatchOverlayHandlers,
    private readonly colors: WatchColors = DEFAULT_WATCH_COLORS
  ) {
    registerWatchOverlay()
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

  update(watches: Watch[]): void {
    this.watches = watches
    for (const entry of this.panes.values()) this.redraw(entry)
  }

  /** The watch whose line is within `HIT_TOLERANCE_PX` of `y` (pane-local pixels) on this
   * pane, nearest first. Null when the click was on empty chart. */
  watchAt(paneId: string, y: number): Watch | null {
    const entry = this.panes.get(paneId)
    if (!entry) return null
    let best: { watch: Watch; distance: number } | null = null
    for (const [watch, level] of this.drawableFor(entry.pane)) {
      const coordinate = entry.chart.convertToPixel({ value: level }, { paneId: CANDLE_PANE })
      const py = Array.isArray(coordinate) ? coordinate[0]?.y : coordinate.y
      if (typeof py !== 'number') continue
      const distance = Math.abs(py - y)
      if (distance > HIT_TOLERANCE_PX) continue
      if (!best || distance < best.distance) best = { watch, distance }
    }
    return best?.watch ?? null
  }

  teardown(): void {
    for (const entry of this.panes.values()) this.clear(entry.chart)
    this.panes.clear()
  }

  /** This pane's instrument's watches that have a price to be drawn at, oldest first. */
  private drawableFor(pane: ChartProPane): Array<[Watch, number]> {
    const symbol = pane.getSymbol()
    const target = instrumentTarget(symbolVendor(symbol), symbol.ticker)
    const rows: Array<[Watch, number]> = []
    for (const watch of this.watches) {
      if (watch.target !== target) continue
      const level = priceLevel(watch)
      if (level !== null) rows.push([watch, level])
    }
    return rows.sort((a, b) => a[0].createdAt - b[0].createdAt)
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
    for (const [watch, level] of this.drawableFor(pane)) {
      const created = overlayFor(watch, level, anchor, this.colors) as OverlayCreate & {
        groupId: string
        onPressedMoveEnd?: (event: { overlay: Overlay }) => boolean
        onRightClick?: (event: { overlay: Overlay; preventDefault?: () => void }) => boolean
      }
      created.groupId = GROUP
      created.onPressedMoveEnd = (event) => {
        const price = event.overlay.points?.[0]?.value
        if (typeof price === 'number') this.handlers.onDragEnd(watch, price)
        return false
      }
      // klinecharts REMOVES an overlay on right-click unless the handler prevents the
      // default (OverlayView._figureMouseRightClickEvent). The menu itself is opened from
      // the pane's own `contextmenu` listener -- which fires for a click on empty chart too,
      // so there is one code path for "watch here" and "this watch" -- but without this the
      // line would vanish from the canvas on the way there.
      created.onRightClick = (event) => {
        event.preventDefault?.()
        return true
      }
      try {
        chart.createOverlay(created)
      } catch (err) {
        console.warn('[watch] overlay create failed', err)
      }
    }
  }
}
