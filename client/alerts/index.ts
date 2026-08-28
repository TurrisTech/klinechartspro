import type { Chart, KLineData } from 'klinecharts'
import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import { openAlertDialog } from './dialog'
import { openContextMenu, type ContextMenu, type MenuItem } from './menu'
import { AlertMonitor, type AlertTrigger } from './monitor'
import { AlertOverlays } from './overlays'
import { loadAlerts } from './store'
import type { AlertNotifier, PriceAlert } from './types'

export { AlertStore, loadAlerts, MAX_ALERTS } from './store'
export { AlertMonitor } from './monitor'
export { observationFor, reach, sideOf, triggers } from './cross'
export type { AlertNotifier, AlertDraft, AlertSide, AlertStatus, PriceAlert } from './types'

// The price-alert feature, assembled. Everything below is wiring: the pieces are
// independently useful and independently tested --
//
//   store.ts      the alerts and where they are kept
//   cross.ts      when one fires (pure)
//   monitor.ts    the live feed, subscribed per instrument, not per pane
//   template.ts   the registered overlay: a line, and the tag on the price axis
//   overlays.ts   one line per alert per pane, dragging, and the hit test
//   menu.ts       the right-click menu (generic)
//   dialog.ts     edit-a-price-then-apply, shared by create and move
//
// -- and this file is the only one that knows they exist together. It depends on the app
// through exactly two things: a `KLineChartPro` and an `AlertNotifier` (types.ts), which is
// the Notification Center's `notify` and nothing more. Neither module imports the other.

const CANDLE_PANE = 'candle_pane'
const SOURCE = 'alerts'

export interface PriceAlertsOptions {
  /** Where a triggered alert goes. `client/notifications`' centre satisfies this. */
  notifier: AlertNotifier
  /** False on a replay wall: the chart is showing history under a read clock, and the
   * monitor's feed is the live market. The lines stay drawn and editable — only the watching
   * stops, which is the same choice client/index.ts makes for the plugins' stream. */
  live: boolean
}

export interface PriceAlertsController {
  /** From the wall's onPanesChange. */
  sync(panes: ChartProPane[]): void
  teardown(): void
}

declare global {
  interface Window {
    __wdAlerts?: { list(): PriceAlert[]; watching(): string[] }
  }
}

export async function mountPriceAlerts(
  chartPro: KLineChartPro,
  options: PriceAlertsOptions
): Promise<PriceAlertsController> {
  const store = await loadAlerts()
  const overlays = new AlertOverlays({
    onDragEnd: (alert, price) => openMoveDialog(alert, price)
  })

  // One subscription drives the drawing: `add`, `rearm`, `markTriggered` and `remove` all
  // emit, so a dropped line that the dialog then cancels is put back by the same path that
  // draws everything else. There is no "revert" branch.
  const unsubscribeStore = store.subscribe((alerts) => overlays.update(alerts))

  const monitor = new AlertMonitor(store, (trigger) => announce(trigger))
  if (options.live) monitor.start()

  // Pane id -> the element the `contextmenu` listener is on, so it can be removed with the
  // pane rather than leaking one per layout change.
  const bound = new Map<string, { element: HTMLElement; handler: (event: MouseEvent) => void }>()
  let menu: ContextMenu | null = null

  window.__wdAlerts = { list: () => store.list(), watching: () => monitor.watching() }

  function announce(trigger: AlertTrigger): void {
    const { alert, price } = trigger
    const precision = precisionFor(alert.vendor, alert.symbol)
    options.notifier.notify({
      title: `${alert.symbol} reached ${alert.price.toFixed(precision)}`,
      body: [
        `Crossed from ${alert.from}. Last ${price.toFixed(precision)}.`,
        alert.note
      ]
        .filter(Boolean)
        .join(' '),
      level: 'alert',
      source: SOURCE,
      at: trigger.at,
      data: { alertId: alert.id, vendor: alert.vendor, symbol: alert.symbol, price: alert.price }
    })
  }

  // -- the gestures ---------------------------------------------------------------------

  function openMoveDialog(alert: PriceAlert, price: number): void {
    const market = marketPrice(alert.vendor, alert.symbol)
    openAlertDialog({
      title: 'Move price alert',
      instrument: alert.symbol,
      price,
      precision: precisionFor(alert.vendor, alert.symbol),
      note: alert.note,
      market: market ?? undefined,
      submitLabel: 'Apply',
      onDelete: () => store.remove(alert.id),
      onSubmit: ({ price: next, note }) => {
        store.rearm(alert.id, next, market ?? next, note)
      },
      // A cancelled drag has already moved the line on the canvas; redrawing from the store
      // is what puts it back, and it is the same call every other change makes.
      onCancel: () => overlays.update(store.list())
    })
  }

  function openCreateDialog(pane: ChartProPane, price: number): void {
    const symbol = pane.getSymbol()
    const market = marketPrice(symbolVendor(symbol), symbol.ticker)
    openAlertDialog({
      title: 'New price alert',
      instrument: symbol.ticker,
      price,
      precision: symbol.pricePrecision,
      market: market ?? undefined,
      submitLabel: 'Create',
      onSubmit: ({ price: level, note }) => {
        store.add({
          vendor: symbolVendor(symbol),
          symbol: symbol.ticker,
          price: level,
          // The side the alert waits on comes from where the MARKET is, not from the number
          // the menu seeded — picking a bar's high seeds it above the market.
          reference: market ?? level,
          note
        })
      }
    })
  }

  function onContextMenu(pane: ChartProPane, element: HTMLElement, event: MouseEvent): void {
    const chart = pane.getChart()
    if (!chart) return
    event.preventDefault()
    menu?.close()

    const rect = element.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const symbol = pane.getSymbol()
    const precision = symbol.pricePrecision ?? 5

    // A right-click ON a line is about that alert; anywhere else is about creating one. One
    // listener rather than the overlay's own onRightClick, so both answers come from the same
    // place and a triggered line behaves like a live one.
    const hit = overlays.alertAt(pane.id, y)
    menu = openContextMenu({
      x: event.clientX,
      y: event.clientY,
      host: element,
      header: hit ? `Alert · ${hit.price.toFixed(precision)}` : `Price alert · ${symbol.ticker}`,
      items: hit ? alertItems(hit, precision) : createItems(pane, chart, x, y, precision),
      onClose: () => {
        menu = null
      }
    })
  }

  function alertItems(alert: PriceAlert, precision: number): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Edit price…',
        detail: alert.price.toFixed(precision),
        onSelect: () => openMoveDialog(alert, alert.price)
      }
    ]
    if (alert.status === 'triggered') {
      items.push({
        label: 'Re-arm here',
        detail: alert.price.toFixed(precision),
        onSelect: () =>
          store.rearm(
            alert.id,
            alert.price,
            marketPrice(alert.vendor, alert.symbol) ?? alert.price
          )
      })
    }
    items.push({ label: 'Delete alert', danger: true, onSelect: () => store.remove(alert.id) })
    return items
  }

  function createItems(
    pane: ChartProPane,
    chart: Chart,
    x: number,
    y: number,
    precision: number
  ): MenuItem[] {
    const cursor = priceAt(chart, y)
    const bar = barAt(chart, x)
    const symbol = pane.getSymbol()
    const market = marketPrice(symbolVendor(symbol), symbol.ticker)
    const rows: Array<{ label: string; price: number | null }> = [
      { label: 'At cursor', price: cursor },
      { label: 'Current price', price: market },
      { label: 'Bar open', price: bar?.open ?? null },
      { label: 'Bar high', price: bar?.high ?? null },
      { label: 'Bar low', price: bar?.low ?? null },
      { label: 'Bar close', price: bar?.close ?? null }
    ]
    return rows
      .filter((row): row is { label: string; price: number } => row.price !== null)
      .map((row) => ({
        label: row.label,
        detail: row.price.toFixed(precision),
        onSelect: () => openCreateDialog(pane, row.price)
      }))
  }

  // -- chart helpers --------------------------------------------------------------------

  /** The price under a pane-local y. */
  function priceAt(chart: Chart, y: number): number | null {
    const point = chart.convertFromPixel([{ y }], { paneId: CANDLE_PANE })
    const value = Array.isArray(point) ? point[0]?.value : point.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  /** The bar under a pane-local x, or null when the cursor is past the last one. */
  function barAt(chart: Chart, x: number): KLineData | null {
    const point = chart.convertFromPixel([{ x }], { paneId: CANDLE_PANE })
    const index = Array.isArray(point) ? point[0]?.dataIndex : point.dataIndex
    if (typeof index !== 'number') return null
    return chart.getDataList()[Math.round(index)] ?? null
  }

  /** The newest close this pane holds — the market price as far as the chart knows, which on
   * a replay wall is deliberately the cursor's, not the live market's. */
  function lastPrice(chart: Chart | null): number | null {
    if (!chart) return null
    const data = chart.getDataList()
    return data.length === 0 ? null : data[data.length - 1].close
  }

  /** The market price an alert is armed against.
   *
   * The MONITOR's reading first, the chart's newest bar only as a fallback. The side an alert
   * waits on and the reading that fires it have to come from one clock: a chart whose newest
   * bar is behind the stream (a file-store dev stack, a pane that has not caught up) would
   * otherwise arm an alert on the wrong side of a market that has already moved, and the very
   * next frame would fire it. The chart still answers for an instrument nothing is watching
   * yet, which is every first alert on a symbol. */
  function marketPrice(vendor: string, symbol: string): number | null {
    const watched = monitor.lastPrice(vendor, symbol)
    if (watched !== null) return watched
    for (const pane of chartPro.getPanes()) {
      const info: SymbolInfo = pane.getSymbol()
      if (symbolVendor(info) !== vendor || info.ticker !== symbol) continue
      const price = lastPrice(pane.getChart())
      if (price !== null) return price
    }
    return null
  }

  /** The instrument's display precision, from any pane showing it. An alert can outlive every
   * pane on its symbol, hence the default. */
  function precisionFor(vendor: string, symbol: string): number {
    for (const pane of chartPro.getPanes()) {
      const info: SymbolInfo = pane.getSymbol()
      if (symbolVendor(info) === vendor && info.ticker === symbol) return info.pricePrecision ?? 5
    }
    return 5
  }

  // -- lifecycle -------------------------------------------------------------------------

  function sync(panes: ChartProPane[]): void {
    overlays.sync(panes)
    const live = new Set(panes.map((pane) => pane.id))
    for (const [id, entry] of bound) {
      if (live.has(id)) continue
      entry.element.removeEventListener('contextmenu', entry.handler)
      bound.delete(id)
    }
    for (const pane of panes) {
      if (bound.has(pane.id)) continue
      // The candle pane's main widget, not the chart root: right-clicking the price axis or
      // a sub-pane is not a price on this scale, and the pane-local coordinates the menu
      // needs are this element's own.
      const element = pane.getChart()?.getDom(CANDLE_PANE, 'main') ?? null
      if (!element) continue
      const handler = (event: MouseEvent): void => onContextMenu(pane, element, event)
      element.addEventListener('contextmenu', handler)
      bound.set(pane.id, { element, handler })
    }
  }

  return {
    sync,
    teardown(): void {
      menu?.close()
      menu = null
      monitor.stop()
      unsubscribeStore()
      overlays.teardown()
      for (const entry of bound.values()) {
        entry.element.removeEventListener('contextmenu', entry.handler)
      }
      bound.clear()
      delete window.__wdAlerts
    }
  }
}
