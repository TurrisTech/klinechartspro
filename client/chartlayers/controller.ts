import type { Chart } from 'klinecharts'
import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import { openSettingsPanel, type SettingsPanelHandle } from './settings'
import { loadLayerConfig, saveLayerConfig } from './store'
import type { ChartLayer, LayerContext } from './types'

// Generic multi-pane lifecycle for a ChartLayer (types.ts): one shared toolbar button that
// opens a settings panel (enable/disable is that panel's first row, not a separate click
// target — see settings.ts), applied independently to every currently-live pane of the wall
// (src/state/wall.svelte.ts) — coverage-gated visibility, debounced redraw on pan/zoom/
// symbol/period change, and a data cache so a style-only config change restyles without
// refetching, all scoped per pane.
//
// `attach` and `sync` are separate calls because `sync` must exist before a `KLineChartPro`
// does, so it can be supplied as that constructor's own `onPanesChange` option
// (client/index.ts) — the wall reports which panes are live from the moment the first one
// mounts, earlier than the constructor call returns.

const DEFAULT_DEBOUNCE_MS = 400

// The server computes over the full price history, so an unbounded query returns bands
// nowhere near the current price. Every price-anchored layer needs a window around the
// visible range, not the whole loaded history — kept here rather than per-layer because it
// is about how much of the chart is on screen, not about what any one layer computes.
const PRICE_WINDOW_FRACTION = 0.06

// The library's slots only exist once ChartPro.svelte has mounted (getSlot() is null before
// then), and 'rail-footer''s own element is additionally destroyed and recreated every time
// the drawing toolbar toggles off and back on — it lives inside ChartPro.svelte's
// `{#if drawingBarVisible}`. Re-parent into whichever instance of the slot currently exists,
// on every relevant DOM change, rather than attaching once: otherwise an attached control
// would vanish for good the first time someone hides the drawing tools instead of merely
// hiding with it. Both slots stay wall-global, not per-pane.
export function attachToSlot(
  chartPro: KLineChartPro,
  slotName: 'toolbar' | 'rail-footer',
  element: HTMLElement
): void {
  let observer: MutationObserver | null = null
  const tryAttach = (): void => {
    const slot = chartPro.getSlot(slotName)
    if (!slot) return
    if (element.parentElement !== slot) slot.appendChild(element)
    if (!observer) {
      const root = slot.closest('.klinecharts-pro')
      if (root) {
        observer = new MutationObserver(tryAttach)
        observer.observe(root, { childList: true, subtree: true })
      }
    }
  }
  tryAttach()
}


// The price band and time window every price-anchored layer fetches against, scoped to
// what is actually on screen rather than every bar paginated in so far.
function buildContext(chart: Chart, symbol: SymbolInfo): LayerContext | null {
  const data = chart.getDataList()
  const range = chart.getVisibleRange()
  const visible = data.slice(Math.max(0, range.realFrom), Math.max(0, range.realTo) + 1)
  if (visible.length === 0) return null

  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const bar of visible) {
    if (bar.low < low) low = bar.low
    if (bar.high > high) high = bar.high
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null

  const pad = Math.max((high - low) * PRICE_WINDOW_FRACTION, high * 1e-4)
  return {
    chart,
    symbol,
    vendor: symbolVendor(symbol),
    priceMin: low - pad,
    priceMax: high + pad,
    from: visible[0].timestamp,
    to: visible[visible.length - 1].timestamp
  }
}

export interface LayerController {
  /** Attaches the layer's single toolbar button once a KLineChartPro instance exists. Call
   * once, right after construction. */
  attach(chartPro: KLineChartPro): void
  /** Reconciles this layer's per-pane wiring against the wall's currently-live panes. Pass
   * straight through as `ChartProOptions.onPanesChange` — built before the chart exists so
   * its `sync` can be supplied at construction time. */
  sync(panes: ChartProPane[]): void
}

interface WiredPane<TDatum> {
  pane: ChartProPane
  chart: Chart
  cache: { key: string; data: TDatum[] } | null
  timer: ReturnType<typeof setTimeout> | null
  onRangeChange: () => void
}

export function createLayerController<TDatum, TConfig extends object>(
  layer: ChartLayer<TDatum, TConfig>
): LayerController {
  let config: TConfig = layer.defaults
  let configLoaded = false
  let enabled = new URLSearchParams(window.location.search).get(layer.id) !== 'off'
  let panel: SettingsPanelHandle | null = null
  const wired = new Map<string, WiredPane<TDatum>>()

  // One button for both "is this layer on" (the is-on accent, kept live even while the
  // panel is closed) and "configure it" (click opens the panel below); the enable/disable
  // switch is the panel's first row, not this button's own click handler.
  const layerButton = document.createElement('button')
  layerButton.type = 'button'
  layerButton.className = 'kc-button wd-layer-toggle'
  layerButton.textContent = layer.label
  layerButton.setAttribute('aria-haspopup', 'dialog')
  layerButton.setAttribute('aria-expanded', 'false')

  const applyToggleState = (): void => {
    layerButton.setAttribute('aria-pressed', String(enabled))
    layerButton.classList.toggle('is-on', enabled)
  }

  const closePanel = (): void => {
    panel?.close()
    panel = null
  }

  // Visible unless NONE of the currently-live panes have coverage — a wall with even one
  // eligible pane keeps the control reachable, rather than hiding it whenever the ACTIVE
  // pane happens to be on an ineligible symbol.
  const updateVisibility = (): void => {
    layerButton.hidden = ![...wired.values()].some((entry) => {
      const symbol = entry.pane.getSymbol()
      return layer.available(symbol, symbolVendor(symbol))
    })
  }

  const clearOverlays = (entry: WiredPane<TDatum>): void => {
    entry.chart.removeOverlay({ groupId: layer.id })
  }

  const paint = (entry: WiredPane<TDatum>, data: TDatum[], ctx: LayerContext): void => {
    clearOverlays(entry)
    if (data.length === 0) return
    const overlays = layer.toOverlays(data, ctx, config).map((overlay) => ({
      ...overlay,
      groupId: layer.id
    }))
    entry.chart.createOverlay(overlays)
  }

  const redraw = async (entry: WiredPane<TDatum>): Promise<void> => {
    if (!enabled) return
    const symbol = entry.pane.getSymbol()
    const available = layer.available(symbol, symbolVendor(symbol))
    updateVisibility()
    if (!available) {
      closePanel()
      clearOverlays(entry)
      return
    }
    const ctx = buildContext(entry.chart, symbol)
    if (!ctx) return

    const key = layer.queryKey(ctx, config)
    if (entry.cache && entry.cache.key === key) {
      paint(entry, entry.cache.data, ctx)
      return
    }
    try {
      const data = await layer.fetch(ctx, config)
      entry.cache = { key, data }
      paint(entry, data, ctx)
    } catch (err) {
      console.error(`[chartlayers] ${layer.id} fetch failed for pane ${entry.pane.id}`, err)
    }
  }

  const scheduleRedraw = (entry: WiredPane<TDatum>): void => {
    if (!enabled) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void redraw(entry)
    }, layer.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  // A style-only change (line width, color, pattern, an emphasis curve) restyles instantly
  // from each pane's own cached fetch — no request. A change to a lever baked into queryKey
  // (which intervals, whether to include spent levels) misses the cache and refetches, per
  // pane, since two panes on different symbols/intervals have independently distinct keys.
  const onConfigChange = (next: TConfig): void => {
    config = next
    saveLayerConfig(layer.id, config)
    for (const entry of wired.values()) {
      if (entry.cache) {
        const ctx = buildContext(entry.chart, entry.pane.getSymbol())
        if (ctx && layer.queryKey(ctx, config) === entry.cache.key) {
          paint(entry, entry.cache.data, ctx)
          continue
        }
      }
      void redraw(entry)
    }
  }

  const onToggleEnabled = (next: boolean): void => {
    enabled = next
    applyToggleState()
    for (const entry of wired.values()) {
      if (enabled) void redraw(entry)
      else clearOverlays(entry)
    }
  }

  layerButton.addEventListener('click', () => {
    if (panel) {
      closePanel()
      return
    }
    layerButton.setAttribute('aria-expanded', 'true')
    panel = openSettingsPanel({
      anchor: layerButton,
      title: `${layer.label} settings`,
      enabled,
      onToggleEnabled,
      fields: layer.fields,
      config,
      defaults: layer.defaults,
      onChange: onConfigChange,
      onClose: () => {
        panel = null
        layerButton.setAttribute('aria-expanded', 'false')
      }
    })
  })

  applyToggleState()
  // Never throws (loadLayerConfig's own contract). Applied to every pane already wired by
  // the time this resolves; a pane that wires AFTER this resolves picks up `config` directly
  // in `sync`'s own initial scheduleRedraw, since `configLoaded` is already true by then.
  void (async () => {
    config = (await loadLayerConfig(layer.id, layer.defaults)) as TConfig
    configLoaded = true
    for (const entry of wired.values()) scheduleRedraw(entry)
  })()

  return {
    attach(chartPro: KLineChartPro): void {
      attachToSlot(chartPro, 'toolbar', layerButton)
    },
    sync(panes: ChartProPane[]): void {
      const live = new Set(panes.map((pane) => pane.id))
      for (const [id, entry] of wired) {
        if (live.has(id)) continue
        if (entry.timer) clearTimeout(entry.timer)
        entry.chart.unsubscribeAction('onVisibleRangeChange', entry.onRangeChange)
        wired.delete(id)
      }
      for (const pane of panes) {
        if (wired.has(pane.id)) continue
        const chart = pane.getChart()
        const entry: WiredPane<TDatum> = {
          pane,
          chart,
          cache: null,
          timer: null,
          onRangeChange: () => {}
        }
        // Pan, zoom and every data load land here, which covers symbol and period
        // switches too.
        entry.onRangeChange = () => scheduleRedraw(entry)
        chart.subscribeAction('onVisibleRangeChange', entry.onRangeChange)
        wired.set(pane.id, entry)
        if (configLoaded) scheduleRedraw(entry)
      }
      updateVisibility()
    }
  }
}
