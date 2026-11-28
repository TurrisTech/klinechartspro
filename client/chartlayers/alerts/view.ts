import type { Chart, OverlayCreate } from 'klinecharts'
import { instrumentZone } from '../../trading/instrument'
import { flash } from '../../watch/menu'
import { getByPath } from '../../plugins/settings/settings'
import { DEFAULT_WATCH_COLORS } from '../../watch/overlays'
import { instrumentTarget, type Watch, type WatchRepeat } from '../../watch/types'
import type { AlertTarget, ChartLayer, LayerAlerts, LayerContext, LayerDecorator } from '../types'
import { openPriceAlertEditor, type PriceAlertBulk, type PriceAlertEditor } from './editor'
import {
  bellStyles,
  ICON_INSET,
  PRICE_ALERT_ICON,
  PRICE_ALERT_ZONE,
  registerPriceAlertFigures,
  type ZoneFigureData
} from './figures'
import type { PriceAlerts } from './hub'
import { describeZone, type Zone, zoneAround, zonePips, zoneUnit } from './zone'
import { formatInstant } from '../../time/format'

// Price alerts ON A LAYER'S PANE: what a click, a hover and an enabled line look like, for any
// chart layer that offers its data (types.ts `LayerAlerts`). This is the layer's DECORATOR
// (types.ts `LayerDecorator`, `priceAlertDecorator` below), handed to the controller by whoever
// builds it: the controller hands it every set of overlays it is about to paint (`decorate`), so
// the handlers and the bells are painted -- and left alone when nothing changed -- exactly as the
// layer's own lines are (paint.ts). The zone band is the one thing drawn outside that path: it
// follows the pointer, in a group of its own.
//
//   click a line          one step round a cycle (user, 2026-11-24: "a click on one level turns
//                         it to alert ... always. a second click, turns it to arm only once. a
//                         third click turns the alert off. clicking again turns it to alert
//                         always"): off -> every time -> once -> off. Each step is said at the
//                         foot of the pane, and the hover says what the next click does. Every
//                         time re-fires on each entry into the zone, after a cooldown; once fires
//                         the first time and stays fired (a grey bell) until the cycle comes round.
//                         The bell is a pill saying which: a 1 for once, a repeat arrow for every
//                         time, struck through when switched off (figures.ts `bellFigures`)
//   click a bell          the alert's dialog: its buffer, the zone, Make default, Remove. A
//                         bell is drawn for EVERY alert on the instrument in view, so one whose
//                         line is no longer drawn (a level spent since, a timeframe switched
//                         off) can still be reached and removed
//   hover either          the alert zone across the pane, with its width and what a click on
//                         that thing does; on a line not yet enabled, the zone a click would
//                         give it, fainter

const CANDLE_PANE = 'candle_pane'

/** The bell's zLevel: over every line it can sit on. klinecharts gives an overlay created
 * without one the pane's overlay COUNT at that moment (StoreImp.addOverlays), so a layer's
 * lines run 0, 1, 2 ... into the hundreds, and a small number put the bell under most of them.
 * Below the hovered overlay's raise (Number.MAX_SAFE_INTEGER), so a hovered bell still rises. */
const BELL_Z_LEVEL = 1_000_000_000

/** What one pane drew with last, and what is shown on it. A line's handlers outlive the paint
 * that made them when the next paint is identical (paint.ts leaves them on the chart), so they
 * read the pane's context from here at the moment of the event, never from what they captured
 * -- a settings edit that only changed the default buffer is such a paint. */
interface PaneState<TConfig> {
  ctx: LayerContext
  config: TConfig
  /** The line or bell under the pointer, by its price. */
  hovered: { price: number; on: 'line' | 'bell' } | null
  /** The alert being edited, and the buffer typed in its editor. */
  editing: { price: number; pips: number } | null
  /** What the zone group holds, as a signature; `''` is nothing. */
  drawn: string
  /** Ends the hover when the pointer leaves the chart, which klinecharts does not report. */
  unlisten: () => void
  /** Writes one of the pane's layer settings (`BindContext.editConfig`); absent when the
   * binding was given none, and then the dialog offers no "Make default". */
  edit?: (key: string, value: unknown) => void
}

function colorFor(watch: Watch): string {
  if (!watch.enabled || watch.status === 'disabled') return DEFAULT_WATCH_COLORS.disabled
  return watch.status === 'fired' ? DEFAULT_WATCH_COLORS.fired : DEFAULT_WATCH_COLORS.armed
}

/** How a line's alert is armed, as the pane and its dialog say it. */
function repeatLabel(repeat: WatchRepeat): string {
  return repeat === 'once' ? 'once' : 'every time'
}

/** Where a click on a line takes its alert: off -> every time -> once -> off. A switched-off alert
 * counts as off; a one-shot that has fired is still once, so the next click turns it off. */
type LineStage = 'off' | WatchRepeat

function stageOf(watch: Watch | null): LineStage {
  if (!watch?.enabled || watch.status === 'disabled') return 'off'
  return watch.repeat
}

function nextStage(watch: Watch | null): LineStage {
  const stage = stageOf(watch)
  return stage === 'off' ? 'always' : stage === 'always' ? 'once' : 'off'
}

/** What the next click on a line does, for the hover. */
function nextClick(watch: Watch | null): string {
  const next = nextStage(watch)
  return next === 'always' ? 'click to alert every time' : next === 'once' ? 'click to alert once' : 'click to turn off'
}

function statusOf(watch: Watch): string {
  if (!watch.enabled || watch.status === 'disabled') return 'Switched off'
  if (watch.status === 'fired') return `Fired ${formatInstant(watch.lastFiredAt, instrumentZone(watch.target))}${watch.repeat === 'once' ? ' · once, so done' : ''}`
  if (watch.repeat === 'once') return 'Armed once: waiting for price to reach the zone'
  if (watch.fireCount > 0) {
    return `Alerted ${watch.fireCount} ${watch.fireCount === 1 ? 'time' : 'times'}, last ${formatInstant(watch.lastFiredAt, instrumentZone(watch.target))}`
  }
  return 'Waiting for price to reach the zone'
}

/** The price alerts' decoration of `layer` on every pane it draws on, over the wall's `alerts`;
 * undefined for a layer that offers its data to none (`ChartLayer.alerts`), which is then painted
 * undecorated. */
export function priceAlertDecorator<TDatum, TConfig>(
  layer: ChartLayer<TDatum, TConfig>,
  alerts: PriceAlerts
): LayerDecorator<TConfig> | undefined {
  return layer.alerts ? new LayerAlertView(layer.id, layer.label, alerts, layer.alerts) : undefined
}

export class LayerAlertView<TDatum, TConfig> implements LayerDecorator<TConfig> {
  private readonly panes = new Map<Chart, PaneState<TConfig>>()
  private editor: { chart: Chart; handle: PriceAlertEditor } | null = null
  /** The lines whose last click is still landing (`cycle`). */
  private readonly landing = new Set<string>()
  private readonly unsubscribe: () => void
  /** The zone band's overlay group: the layer's own id, suffixed, so that removing the layer's
   * overlays never takes the band and one layer's band never takes another's. */
  private readonly zoneGroup: string

  constructor(
    layerId: string,
    /** The layer's name on screen, which names its alerts in the dialog's foot. */
    private readonly label: string,
    private readonly alerts: PriceAlerts,
    private readonly offer: LayerAlerts<TDatum>
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
  decorate(
    overlays: OverlayCreate[],
    ctx: LayerContext,
    config: TConfig,
    edit?: (key: string, value: unknown) => void
  ): OverlayCreate[] {
    this.observe(ctx, config, edit)
    const out: OverlayCreate[] = overlays.map((overlay) => {
      // klinecharts raises a hovered overlay above every other one until the pointer leaves it,
      // and a live line runs on under its own bell -- so a pointer that slid along the line onto
      // the bell kept the line, and the click meant for the dialog turned the alert off. Held at
      // its own level, the line stays under the bell (BELL_Z_LEVEL) whatever is hovered.
      const line: OverlayCreate = { ...overlay, fixedZLevel: true }
      const datum = overlay.extendData
      if (datum === undefined || datum === null) return line
      const target = this.offer.target(datum as TDatum)
      // Handlers are left out of the paint signature, so they are attached whether or not the
      // wall has a backend yet: one connected later finds them already on the chart.
      return target ? { ...line, ...this.handlers(target, ctx.chart) } : line
    })
    out.push(...this.icons(ctx))
    return out
  }

  /** An alert made, edited, removed or fired -- here, on another pane, or by its firing -- changes
   * which bells a pane draws. */
  subscribe(repaint: () => void): () => void {
    return this.alerts.subscribe(repaint)
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

  private observe(ctx: LayerContext, config: TConfig, edit?: (key: string, value: unknown) => void): void {
    const state = this.panes.get(ctx.chart)
    if (state) {
      state.ctx = ctx
      state.config = config
      state.edit = edit
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
      unlisten: () => dom?.removeEventListener('mouseleave', leave),
      edit
    })
  }

  /** The pane's default buffer for a new alert, from the layer's own setting. */
  private defaultPips(config: TConfig): number {
    const value = Number(getByPath(config as object, this.offer.zonePipsSetting))
    return Number.isFinite(value) && value >= 0 ? value : 0
  }

  private handlers(target: AlertTarget, chart: Chart): Pick<OverlayCreate, 'onClick' | 'onMouseEnter' | 'onMouseLeave'> {
    return {
      onClick: () => void this.cycle(chart, target),
      onMouseEnter: () => this.hover(chart, { price: target.price, on: 'line' }),
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
        zLevel: BELL_Z_LEVEL,
        // Only `y` is read (figures.ts); the newest visible bar is one the chart holds.
        points: [{ timestamp: ctx.to, value: zone.center }],
        // The pill says how it is armed: 1 for once, a repeat arrow for every time, struck when off.
        styles: bellStyles(colorFor(watch), stageOf(watch)),
        onClick: () => this.openEditor(chart, zone.center),
        onMouseEnter: () => this.hover(chart, { price: zone.center, on: 'bell' }),
        onMouseLeave: () => this.hover(chart, null)
      })
    }
    return icons
  }

  // -- gestures -------------------------------------------------------------------------

  private hover(chart: Chart, hovered: PaneState<TConfig>['hovered']): void {
    const state = this.panes.get(chart)
    if (!state) return
    if (state.hovered?.price === hovered?.price && state.hovered?.on === hovered?.on) return
    state.hovered = hovered
    this.render(chart)
  }

  /** A click on a line moves its alert one step round the cycle (`nextStage`): off -> every
   * time -> once -> off. Where alerts cannot be set here, the reason instead. A click while the
   * last one is still landing is ignored, so a quick double click is one step, never a skip. */
  private async cycle(chart: Chart, target: AlertTarget): Promise<void> {
    const state = this.panes.get(chart)
    const host = chart.getDom()
    if (!state || !host || !this.alerts.available) return
    const { ctx } = state
    const precision = ctx.symbol.pricePrecision ?? 5
    const key = `${ctx.vendor}:${ctx.symbol.ticker}|${target.price.toFixed(precision)}`
    if (this.landing.has(key)) return
    const existing = this.alerts.at(ctx.vendor, ctx.symbol.ticker, target.price, precision)
    const next = nextStage(existing?.watch ?? null)
    if (next !== 'off' && !existing) {
      const refusal = this.alerts.refusal(instrumentTarget(ctx.vendor, ctx.symbol.ticker))
      if (refusal) {
        flash(host, refusal)
        return
      }
    }
    this.landing.add(key)
    try {
      if (next === 'off') await this.turnOff(chart, target)
      else await this.arm(chart, target, next)
    } finally {
      this.landing.delete(key)
    }
  }

  /** The line's alert armed once or every time: made (the pane's default buffer) when there is
   * none, otherwise switched to that and armed afresh. Said at the foot of the pane. */
  private async arm(chart: Chart, target: AlertTarget, repeat: WatchRepeat): Promise<void> {
    const state = this.panes.get(chart)
    if (!state) return
    const { ctx, config } = state
    const precision = ctx.symbol.pricePrecision ?? 5
    const host = chart.getDom()
    const say = (text: string): void => {
      if (host) flash(host, text)
    }
    const line = `${target.label} ${target.price.toFixed(precision)}`
    const existing = this.alerts.at(ctx.vendor, ctx.symbol.ticker, target.price, precision)
    let watch: Watch | null
    try {
      watch = existing ? await this.alerts.setRepeat(existing.watch.id, repeat) : await this.alerts.enable(ctx.symbol, target, this.defaultPips(config), repeat)
    } catch {
      watch = null
    }
    const alert = watch ? this.alerts.get(watch.id) : null
    if (!alert) {
      say("Couldn't set an alert here")
      return
    }
    say(`Alert ${repeatLabel(repeat)} · ${line} · ${describeZone(alert.zone, zoneUnit(ctx.symbol), precision)}`)
  }

  private async turnOff(chart: Chart, target: AlertTarget): Promise<void> {
    const state = this.panes.get(chart)
    if (!state) return
    const { ctx } = state
    const precision = ctx.symbol.pricePrecision ?? 5
    const existing = this.alerts.at(ctx.vendor, ctx.symbol.ticker, target.price, precision)
    if (!existing) return
    if (this.editor?.chart === chart) this.editor.handle.close()
    await this.alerts.remove(existing.watch.id)
    const host = chart.getDom()
    if (host) flash(host, `Alert off · ${target.label} ${target.price.toFixed(precision)}`)
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
    const edit = state.edit
    const handle = openPriceAlertEditor({
      host,
      anchor: this.bellAt(chart, center),
      title: alert.watch.name || `${ctx.symbol.ticker} ${center.toFixed(precision)}`,
      unitLabel: unit.label,
      pips,
      defaultPips: this.defaultPips(state.config),
      // The pane's own setting, written as its gear would write it: the pane is rebound with
      // it, so the next click on a line anywhere on this pane takes it.
      onMakeDefault: edit ? (typed) => edit(this.offer.zonePipsSetting, typed) : undefined,
      status: statusOf(alert.watch),
      describe: (typed) => describeZone(zoneAround(center, typed, unit, precision), unit, precision),
      onPreview: (typed) => {
        if (!state.editing) return
        state.editing.pips = typed
        this.render(chart)
      },
      onCommit: (typed) => void this.alerts.setPips(id, state.ctx.symbol, typed),
      onRemove: () => void this.alerts.remove(id),
      bulk: this.bulkFor(state),
      onClose: () => {
        if (this.editor?.handle === handle) this.editor = null
        state.editing = null
        this.render(chart)
      }
    })
    this.editor = { chart, handle }
    this.render(chart)
  }

  /** The dialog's foot: every alert of this layer on the pane's instrument, and those of them
   * that are stale when the layer can tell (`LayerAlerts.stale`, asked as the dialog opens).
   * Whatever is removed is said at the foot of the pane. */
  private bulkFor(state: PaneState<TConfig>): PriceAlertBulk | undefined {
    const { ctx } = state
    const host = ctx.chart.getDom()
    const mine = this.alerts
      .forInstrument(ctx.vendor, ctx.symbol.ticker)
      .filter((alert) => this.offer.owns?.(alert) ?? true)
    if (mine.length === 0) return undefined
    const what = `${this.label} alerts on ${ctx.symbol.ticker}`
    const said = (removed: number, kind: string): void => {
      if (host) flash(host, `Removed ${removed} ${kind}${this.label} ${removed === 1 ? 'alert' : 'alerts'} on ${ctx.symbol.ticker}`)
    }
    const stale = this.offer.stale?.(mine, ctx)
    // Settled here as well, so a dialog closed before the answer leaves no unhandled rejection.
    stale?.catch(() => undefined)
    return {
      title: what,
      count: mine.length,
      stale: stale?.then(
        (ids) => ids.length,
        () => null
      ),
      onRemoveStale: () => {
        void stale?.then(async (ids) => said(await this.alerts.removeMany(ids), 'stale '))
      },
      onRemoveAll: () => {
        void this.alerts.removeMany(mine.map((alert) => alert.watch.id)).then((removed) => said(removed, ''))
      }
    }
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
    const hovered = state.hovered
    if (hovered === null) return null
    const alert = this.alerts.at(ctx.vendor, ctx.symbol.ticker, hovered.price, precision)
    if (alert) {
      // How it is armed, and what a click on the thing under the pointer does: the line moves it
      // one step round the cycle, the bell opens it.
      const now = stageOf(alert.watch) === 'off' ? 'switched off' : `alert ${repeatLabel(alert.watch.repeat)}`
      const does = `${now} · ${hovered.on === 'line' ? nextClick(alert.watch) : 'click for options'}`
      return { low: alert.zone.low, high: alert.zone.high, label: `${caption(alert.zone)} · ${does}`, color, preview: false }
    }
    if (!this.alerts.available || this.alerts.refusal(instrumentTarget(ctx.vendor, ctx.symbol.ticker))) return null
    const zone = zoneAround(hovered.price, this.defaultPips(config), unit, precision)
    return {
      low: zone.low,
      high: zone.high,
      label: `Click to alert every time · zone ${describeZone(zone, unit, precision)}`,
      color,
      preview: true
    }
  }

  private render(chart: Chart): void {
    const state = this.panes.get(chart)
    if (!state) return
    const shown = this.zoneShown(state)
    const anchor = state.editing?.price ?? state.hovered?.price ?? null
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
