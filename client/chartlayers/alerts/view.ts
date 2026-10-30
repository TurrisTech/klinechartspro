import type { Chart, OverlayCreate } from 'klinecharts'
import { formatInstant } from '../../trading/format'
import { flash } from '../../watch/menu'
import { DEFAULT_WATCH_COLORS } from '../../watch/overlays'
import { instrumentTarget, type Watch } from '../../watch/types'
import type { AlertTarget, LayerAlerts, LayerContext } from '../types'
import { openPriceAlertEditor, type PriceAlertEditor } from './editor'
import {
  ICON_INSET,
  PRICE_ALERT_ICON,
  PRICE_ALERT_ZONE,
  registerPriceAlertFigures,
  type ZoneFigureData
} from './figures'
import type { PriceAlerts } from './hub'
import { describeZone, type Zone, zoneAround, zonePips, zoneUnit } from './zone'

// Price alerts ON A LAYER'S PANE: what a click, a hover and an enabled line look like, for any
// chart layer that offers its data (types.ts `LayerAlerts`). The controller hands this every
// set of overlays it is about to paint (`decorate`), so the handlers and the bells are painted
// -- and left alone when nothing changed -- exactly as the layer's own lines are (paint.ts).
// The zone band is the one thing drawn outside that path: it follows the pointer, in a group
// of its own.
//
//   click a line          enables it (the pane's default buffer) and opens its editor
//   click an enabled one  opens its editor -- the buffer, the zone, Remove
//   click a bell          the same: a bell is drawn for EVERY alert on the instrument in
//                         view, so one whose line is no longer drawn (a level spent since, a
//                         timeframe switched off) can still be reached and removed
//   hover either          the alert zone across the pane, with its width; on a line not yet
//                         enabled, the zone a click would give it, fainter

const CANDLE_PANE = 'candle_pane'

/** What one pane drew with last, and what is shown on it. A line's handlers outlive the paint
 * that made them when the next paint is identical (paint.ts leaves them on the chart), so they
 * read the pane's context from here at the moment of the event, never from what they captured
 * -- a settings edit that only changed the default buffer is such a paint. */
interface PaneState<TConfig> {
  ctx: LayerContext
  config: TConfig
  /** The price of the line or bell under the pointer. */
  hovered: number | null
  /** The alert being edited, and the buffer typed in its editor. */
  editing: { price: number; pips: number } | null
  /** What the zone group holds, as a signature; `''` is nothing. */
  drawn: string
  /** Ends the hover when the pointer leaves the chart, which klinecharts does not report. */
  unlisten: () => void
}

function colorFor(watch: Watch): string {
  if (!watch.enabled || watch.status === 'disabled') return DEFAULT_WATCH_COLORS.disabled
  return watch.status === 'fired' ? DEFAULT_WATCH_COLORS.fired : DEFAULT_WATCH_COLORS.armed
}

function statusOf(watch: Watch): string {
  if (!watch.enabled || watch.status === 'disabled') return 'Switched off'
  if (watch.status === 'fired') return `Fired ${formatInstant(watch.lastFiredAt)}`
  if (watch.fireCount > 0) {
    return `Alerted ${watch.fireCount} ${watch.fireCount === 1 ? 'time' : 'times'}, last ${formatInstant(watch.lastFiredAt)}`
  }
  return 'Waiting for price to reach the zone'
}

export class LayerAlertView<TDatum, TConfig> {
  private readonly panes = new Map<Chart, PaneState<TConfig>>()
  private editor: { chart: Chart; handle: PriceAlertEditor } | null = null
  private readonly unsubscribe: () => void
  /** The zone band's overlay group: the layer's own id, suffixed, so that removing the layer's
   * overlays never takes the band and one layer's band never takes another's. */
  private readonly zoneGroup: string

  constructor(
    layerId: string,
    private readonly alerts: PriceAlerts,
    private readonly offer: LayerAlerts<TDatum, TConfig>
  ) {
    this.zoneGroup = `${layerId}-alert-zone`
    registerPriceAlertFigures()
    // An alert made, edited or removed -- here, on another pane, or by its firing -- changes
    // what a band on screen says.
    this.unsubscribe = alerts.subscribe(() => {
      for (const chart of this.panes.keys()) this.render(chart)
    })
  }

  /** `overlays` with the alerts' part added: every line of a datum that can have an alert
   * answers a click and a hover, and a bell is appended for every alert in the price band.
   * Called on every paint, whether or not the chart is then touched. */
  decorate(overlays: OverlayCreate[], ctx: LayerContext, config: TConfig): OverlayCreate[] {
    this.observe(ctx, config)
    const out: OverlayCreate[] = overlays.map((overlay) => {
      const datum = overlay.extendData
      if (datum === undefined || datum === null) return overlay
      const target = this.offer.target(datum as TDatum)
      // Handlers are left out of the paint signature, so they are attached whether or not the
      // wall has a backend yet: one connected later finds them already on the chart.
      return target ? { ...overlay, ...this.handlers(target, ctx.chart) } : overlay
    })
    out.push(...this.icons(ctx))
    return out
  }

  /** The layer is no longer drawing on `chart`: nothing of this may stay on it. */
  clear(chart: Chart): void {
    const state = this.panes.get(chart)
    if (!state) return
    if (this.editor?.chart === chart) this.editor.handle.close()
    state.hovered = null
    state.editing = null
    this.render(chart)
    state.unlisten()
    this.panes.delete(chart)
  }

  dispose(): void {
    this.editor?.handle.close()
    for (const chart of [...this.panes.keys()]) this.clear(chart)
    this.unsubscribe()
  }

  private observe(ctx: LayerContext, config: TConfig): void {
    const state = this.panes.get(ctx.chart)
    if (state) {
      state.ctx = ctx
      state.config = config
      return
    }
    const dom = ctx.chart.getDom()
    const leave = (): void => this.hover(ctx.chart, null)
    dom?.addEventListener('mouseleave', leave)
    this.panes.set(ctx.chart, {
      ctx,
      config,
      hovered: null,
      editing: null,
      drawn: '',
      unlisten: () => dom?.removeEventListener('mouseleave', leave)
    })
  }

  private handlers(target: AlertTarget, chart: Chart): Pick<OverlayCreate, 'onClick' | 'onMouseEnter' | 'onMouseLeave'> {
    return {
      onClick: () => void this.click(chart, target),
      onMouseEnter: () => this.hover(chart, target.price),
      onMouseLeave: () => this.hover(chart, null)
    }
  }

  private icons(ctx: LayerContext): OverlayCreate[] {
    const icons: OverlayCreate[] = []
    for (const { watch, zone } of this.alerts.forInstrument(ctx.vendor, ctx.symbol.ticker)) {
      if (zone.center < ctx.priceMin || zone.center > ctx.priceMax) continue
      const chart = ctx.chart
      icons.push({
        name: PRICE_ALERT_ICON,
        paneId: CANDLE_PANE,
        lock: true,
        // Over the lines it sits on.
        zLevel: 1,
        // Only `y` is read (figures.ts); the newest visible bar is one the chart holds.
        points: [{ timestamp: ctx.to, value: zone.center }],
        styles: { rect: { color: colorFor(watch) } },
        onClick: () => this.openEditor(chart, zone.center),
        onMouseEnter: () => this.hover(chart, zone.center),
        onMouseLeave: () => this.hover(chart, null)
      })
    }
    return icons
  }

  // -- gestures -------------------------------------------------------------------------

  private hover(chart: Chart, price: number | null): void {
    const state = this.panes.get(chart)
    if (!state || state.hovered === price) return
    state.hovered = price
    this.render(chart)
  }

  private async click(chart: Chart, target: AlertTarget): Promise<void> {
    const state = this.panes.get(chart)
    if (!state || !this.alerts.available) return
    const { ctx, config } = state
    const precision = ctx.symbol.pricePrecision ?? 5
    if (this.alerts.at(ctx.vendor, ctx.symbol.ticker, target.price, precision)) {
      this.openEditor(chart, target.price)
      return
    }
    const host = chart.getDom()
    const refusal = this.alerts.refusal(instrumentTarget(ctx.vendor, ctx.symbol.ticker))
    if (refusal) {
      if (host) flash(host, refusal)
      return
    }
    const watch = await this.alerts.enable(ctx.symbol, target, this.offer.zonePips(config))
    if (!watch) {
      if (host) flash(host, "Couldn't set an alert here")
      return
    }
    this.openEditor(chart, target.price)
  }

  private openEditor(chart: Chart, price: number): void {
    const state = this.panes.get(chart)
    const host = chart.getDom()
    if (!state || !host) return
    const { ctx } = state
    const precision = ctx.symbol.pricePrecision ?? 5
    const alert = this.alerts.at(ctx.vendor, ctx.symbol.ticker, price, precision)
    if (!alert) return
    this.editor?.handle.close()
    const unit = zoneUnit(ctx.symbol)
    const center = alert.zone.center
    const id = alert.watch.id
    const pips = zonePips(alert.zone, unit)
    state.editing = { price: center, pips }
    const handle = openPriceAlertEditor({
      host,
      anchor: this.bellAt(chart, center),
      title: alert.watch.name || `${ctx.symbol.ticker} ${center.toFixed(precision)}`,
      unitLabel: unit.label,
      pips,
      status: statusOf(alert.watch),
      describe: (typed) => describeZone(zoneAround(center, typed, unit, precision), unit, precision),
      onPreview: (typed) => {
        if (!state.editing) return
        state.editing.pips = typed
        this.render(chart)
      },
      onCommit: (typed) => void this.alerts.setPips(id, state.ctx.symbol, typed),
      onRemove: () => void this.alerts.remove(id),
      onClose: () => {
        if (this.editor?.handle === handle) this.editor = null
        state.editing = null
        this.render(chart)
      }
    })
    this.editor = { chart, handle }
    this.render(chart)
  }

  /** Where the bell of the line at `price` is, in viewport coordinates. */
  private bellAt(chart: Chart, price: number): { x: number; y: number } | null {
    const main = chart.getDom(CANDLE_PANE, 'main')
    if (!main) return null
    const rect = main.getBoundingClientRect()
    const point = chart.convertToPixel({ value: price }, { paneId: CANDLE_PANE })
    const y = (Array.isArray(point) ? point[0] : point)?.y
    return {
      x: rect.right - ICON_INSET,
      y: rect.top + (typeof y === 'number' ? y : rect.height / 2)
    }
  }

  // -- the zone band --------------------------------------------------------------------

  /** The band the pane should show now, or null. The editor's wins over the pointer's. */
  private zoneShown(state: PaneState<TConfig>): ZoneFigureData | null {
    const { ctx, config } = state
    const precision = ctx.symbol.pricePrecision ?? 5
    const unit = zoneUnit(ctx.symbol)
    const color = DEFAULT_WATCH_COLORS.armed
    const caption = (zone: Zone): string => `Alert zone ${describeZone(zone, unit, precision)}`
    if (state.editing) {
      const zone = zoneAround(state.editing.price, state.editing.pips, unit, precision)
      return { low: zone.low, high: zone.high, label: caption(zone), color, preview: false }
    }
    if (state.hovered === null) return null
    const alert = this.alerts.at(ctx.vendor, ctx.symbol.ticker, state.hovered, precision)
    if (alert) {
      return { low: alert.zone.low, high: alert.zone.high, label: caption(alert.zone), color, preview: false }
    }
    if (!this.alerts.available || this.alerts.refusal(instrumentTarget(ctx.vendor, ctx.symbol.ticker))) return null
    const zone = zoneAround(state.hovered, this.offer.zonePips(config), unit, precision)
    return {
      low: zone.low,
      high: zone.high,
      label: `Click to alert · zone ${describeZone(zone, unit, precision)}`,
      color,
      preview: true
    }
  }

  private render(chart: Chart): void {
    const state = this.panes.get(chart)
    if (!state) return
    const shown = this.zoneShown(state)
    const anchor = state.editing?.price ?? state.hovered
    const signature = shown && anchor !== null ? JSON.stringify([anchor, state.ctx.to, shown]) : ''
    if (signature === state.drawn) return
    try {
      if (state.drawn !== '') chart.removeOverlay({ groupId: this.zoneGroup })
      state.drawn = signature
      if (!shown || anchor === null) return
      chart.createOverlay({
        name: PRICE_ALERT_ZONE,
        groupId: this.zoneGroup,
        paneId: CANDLE_PANE,
        lock: true,
        // Under the lines and the bell it describes.
        zLevel: -1,
        points: [{ timestamp: state.ctx.to, value: anchor }],
        extendData: shown
      })
    } catch {
      // the chart is gone
    }
  }
}
