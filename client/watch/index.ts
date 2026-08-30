import type { Chart, KLineData } from 'klinecharts'
import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { hasFeature } from '../capabilities'
import { symbolVendor } from '../symbols'
import { openWatchDialog } from './dialog'
import { openContextMenu, type ContextMenu, type MenuItem } from './menu'
import { WatchOverlays } from './overlays'
import { loadWatches, type WatchStore } from './store'
import {
  instrumentTarget,
  PRICE_SOURCE,
  priceCondition,
  priceDirection,
  priceLevel,
  type Watch
} from './types'

export { watchApi } from './api'
export { loadWatches, WatchStore } from './store'
export {
  instrumentTarget,
  PRICE_DIRECTIONS,
  PRICE_SOURCE,
  priceCondition,
  priceDirection,
  priceLevel
} from './types'
export type { Condition, PriceDirection, Watch, WatchDraft, WatchSource } from './types'

// PRICE WATCHES on the chart: a line per level, right-click to place one, drag to move it.
//
// This module is a VIEW. The watches live on the server (`wdashboard_server/watch`), which is
// what makes them fire with this tab closed, across a reload and across a rollout -- so
// there is no monitor here, no crossing rule here, and no persistence here. Everything below
// is chart gestures turned into `/watch` calls:
//
//   store.ts     this browser's cache of the server's watches
//   api.ts       the /watch wire
//   template.ts  the registered overlay: a line, and the tag on the price axis
//   overlays.ts  one line per drawable watch per pane, dragging, and the hit test
//   menu.ts      the right-click menu (generic)
//   dialog.ts    set-a-price-then-apply, shared by create and move
//
// A price watch is one SHAPE of watch: the `price` source, one leaf, on the `price` field.
// Everything else the server can hold -- a bar's close, a combinator, a third-party source --
// is a perfectly good watch that this chart layer simply has no line for (`priceLevel`
// returns null and it is skipped). The notifications they raise are the Notification
// Center's business, not this module's: it never imports it.
//
// The BACKEND is an argument. By default it is this browser's view of the server's watches;
// a BAR REPLAY hands in one that evaluates in this tab against the bars the replay walks
// (client/replay/watches.ts), because no server-side source can see a replay's market. Both
// are a `WatchStore` over a `WatchApi`, so everything below -- the gestures, the dialog, the
// lines, the axis tags -- is the same code either way.

const CANDLE_PANE = 'candle_pane'

export interface PriceWatchesOptions {
  /** The watches to draw. Default: this browser's view of the SERVER's (`loadWatches`). */
  store?: WatchStore
  /** Why this instrument cannot be watched on this wall, or null when it can. A replay walks
   * one instrument, so its other panes get a reason instead of rows that would create a watch
   * nothing will ever evaluate. */
  canWatch?: (target: string) => string | null
}

export interface PriceWatchesController {
  /** From the wall's onPanesChange. */
  sync(panes: ChartProPane[]): void
  /** A watch fired (or something else changed one) — re-read the list so the lines follow. */
  refresh(): void
  teardown(): void
}

declare global {
  interface Window {
    __wdWatches?: { list(): Watch[]; sources(): string[] }
  }
}

/** Null when there is nothing to draw watches from: with no `store` of its own this is a
 * view of the server's, and an older server cannot hold a watch. A browser-side monitor is
 * not a substitute for one on a LIVE wall -- it cannot fire with the tab closed, which is the
 * whole feature -- but it is exactly right for a replay, whose market only exists here. */
export async function mountPriceWatches(
  chartPro: KLineChartPro,
  options: PriceWatchesOptions = {}
): Promise<PriceWatchesController | null> {
  if (!options.store && !hasFeature('watch')) return null
  const store: WatchStore = options.store ?? (await loadWatches())
  const overlays = new WatchOverlays({
    onDragEnd: (watch, price) => openMoveDialog(watch, price)
  })

  // One subscription drives the drawing: create, update, arm, delete and refresh all emit,
  // so a dropped line that the dialog then cancels is put back by the same path that draws
  // everything else. There is no "revert" branch.
  const unsubscribe = store.subscribe((watches) => overlays.update(watches))

  const bound = new Map<string, { element: HTMLElement; handler: (event: MouseEvent) => void }>()
  let menu: ContextMenu | null = null

  window.__wdWatches = {
    list: () => store.list(),
    sources: () => store.catalogue().map((source) => source.id)
  }

  // -- the gestures ---------------------------------------------------------------------

  function openMoveDialog(watch: Watch, price: number): void {
    const market = marketPrice(watch.target)
    openWatchDialog({
      title: 'Move price watch',
      instrument: instrumentOf(watch.target),
      price,
      precision: precisionFor(watch.target),
      note: watch.note,
      direction: priceDirection(watch),
      repeat: watch.repeat === 'always',
      market: market ?? undefined,
      submitLabel: 'Apply',
      onDelete: () => void store.remove(watch.id),
      onSubmit: ({ price: level, direction, note, repeat }) => {
        // One PATCH: a new condition re-arms the watch server-side, which re-seeds the
        // crossing baseline from the market as it stands now. That is the whole reason the
        // client does not compute a side.
        void store.update(watch.id, {
          condition: priceCondition(level, direction),
          note: note ?? '',
          repeat: repeat ? 'always' : 'once'
        })
      },
      // A cancelled drag has already moved the line on the canvas; redrawing from the store
      // is what puts it back, and it is the same call every other change makes.
      onCancel: () => overlays.update(store.list())
    })
  }

  function openCreateDialog(pane: ChartProPane, price: number): void {
    const symbol = pane.getSymbol()
    const target = instrumentTarget(symbolVendor(symbol), symbol.ticker)
    openWatchDialog({
      title: 'New price watch',
      instrument: symbol.ticker,
      price,
      precision: symbol.pricePrecision,
      market: marketPrice(target) ?? undefined,
      submitLabel: 'Create',
      onSubmit: ({ price: level, direction, note, repeat }) => {
        void store.create({
          source: PRICE_SOURCE,
          target,
          condition: priceCondition(level, direction),
          name: `${symbol.ticker} ${level.toFixed(symbol.pricePrecision ?? 5)}`,
          note: note ?? '',
          repeat: repeat ? 'always' : 'once'
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

    // A right-click ON a line is about that watch; anywhere else is about creating one. One
    // listener rather than the overlay's own onRightClick, so both answers come from the same
    // place and a fired line behaves like a live one.
    const hit = overlays.watchAt(pane.id, y)
    const level = hit === null ? null : priceLevel(hit)
    menu = openContextMenu({
      x: event.clientX,
      y: event.clientY,
      host: element,
      header:
        hit && level !== null
          ? `Watch · ${level.toFixed(precision)}`
          : `Price watch · ${symbol.ticker}`,
      items:
        hit && level !== null
          ? watchItems(hit, level, precision)
          : createItems(pane, chart, x, y, precision),
      onClose: () => {
        menu = null
      }
    })
  }

  function watchItems(watch: Watch, level: number, precision: number): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Edit price…',
        detail: level.toFixed(precision),
        onSelect: () => openMoveDialog(watch, level)
      }
    ]
    if (watch.status !== 'armed') {
      items.push({
        label: 'Re-arm here',
        detail: level.toFixed(precision),
        onSelect: () => void store.arm(watch.id)
      })
    }
    items.push({ label: 'Delete watch', danger: true, onSelect: () => void store.remove(watch.id) })
    return items
  }

  function createItems(
    pane: ChartProPane,
    chart: Chart,
    x: number,
    y: number,
    precision: number
  ): MenuItem[] {
    const symbol = pane.getSymbol()
    const target = instrumentTarget(symbolVendor(symbol), symbol.ticker)
    const refusal = options.canWatch?.(target) ?? null
    // One disabled row rather than six that lead nowhere: a wall can show instruments this
    // backend does not watch, and silently accepting a watch on one is the failure this
    // avoids.
    if (refusal !== null) return [{ label: refusal, disabled: true, onSelect: () => {} }]
    const cursor = priceAt(chart, y)
    const bar = barAt(chart, x)
    const market = marketPrice(target)
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

  function instrumentOf(target: string): string {
    return target.split('@')[0].split(':').pop() ?? target
  }

  /** The newest close any pane on this instrument holds. Context for the dialog only: the
   * side a crossing waits on is the SERVER's to decide, from its own feed at the moment the
   * watch is armed, so nothing here has to be authoritative about the market. */
  function marketPrice(target: string): number | null {
    for (const pane of chartPro.getPanes()) {
      const symbol: SymbolInfo = pane.getSymbol()
      if (instrumentTarget(symbolVendor(symbol), symbol.ticker) !== target) continue
      const data = pane.getChart()?.getDataList() ?? []
      if (data.length > 0) return data[data.length - 1].close
    }
    return null
  }

  function precisionFor(target: string): number {
    for (const pane of chartPro.getPanes()) {
      const symbol: SymbolInfo = pane.getSymbol()
      if (instrumentTarget(symbolVendor(symbol), symbol.ticker) === target) {
        return symbol.pricePrecision ?? 5
      }
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
    refresh: () => void store.refresh(),
    teardown(): void {
      menu?.close()
      menu = null
      unsubscribe()
      overlays.teardown()
      for (const entry of bound.values()) {
        entry.element.removeEventListener('contextmenu', entry.handler)
      }
      bound.clear()
      delete window.__wdWatches
    }
  }
}
