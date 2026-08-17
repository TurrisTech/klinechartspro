import type { Chart } from 'klinecharts'
import type { KLineChartPro, SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import { openSettingsPanel, type SettingsPanelHandle } from './settings'
import { loadLayerConfig, saveLayerConfig } from './store'
import type { ChartLayer, LayerContext } from './types'

// Generic lifecycle for a ChartLayer (types.ts): one toolbar button that opens a settings
// panel (enable/disable is that panel's first row, not a separate click target — see
// settings.ts), coverage-gated visibility, debounced redraw on pan/zoom/symbol/period
// change, and a data cache so a style-only config change restyles without refetching. One
// call per layer — client/levels/layer.ts is mounted with `mountLayer(chartPro, levelsLayer)`,
// and a second server-derived layer is mounted the same way.

const DEFAULT_DEBOUNCE_MS = 400

// The server computes over the full price history, so an unbounded query returns bands
// nowhere near the current price. Every price-anchored layer needs a window around the
// visible range, not the whole loaded history — kept here rather than per-layer because it
// is about how much of the chart is on screen, not about what any one layer computes.
const PRICE_WINDOW_FRACTION = 0.06

// Svelte 5's `mount()` does not flush the component's onMount synchronously, so the
// KLineChart instance does not exist yet when the KLineChartPro constructor returns —
// getChart() is null for the first few frames. Poll rather than reach into Svelte's
// scheduler, and give up rather than spin forever if the chart genuinely failed to build.
export function whenChartReady(chartPro: KLineChartPro, timeoutMs = 5_000): Promise<Chart | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs
    const poll = (): void => {
      const chart = chartPro.getChart()
      if (chart) resolve(chart)
      else if (performance.now() > deadline) resolve(null)
      else requestAnimationFrame(poll)
    }
    poll()
  })
}

// The library's slots only exist once ChartPro.svelte has mounted (getSlot() is null before
// then), and 'rail-footer''s own element is additionally destroyed and recreated every time
// the drawing toolbar toggles off and back on — it lives inside ChartPro.svelte's
// `{#if drawingBarVisible}`. Re-parent into whichever instance of the slot currently exists,
// on every relevant DOM change, rather than attaching once: otherwise an attached control
// would vanish for good the first time someone hides the drawing tools instead of merely
// hiding with it.
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

export async function mountLayer<TDatum, TConfig extends object>(
  chartPro: KLineChartPro,
  layer: ChartLayer<TDatum, TConfig>
): Promise<void> {
  const chart = await whenChartReady(chartPro)
  if (!chart) {
    console.warn(`[chartlayers] chart unavailable, ${layer.id} disabled`)
    return
  }

  // `as TConfig`: awaiting a call whose return type depends on an unresolved generic infers
  // `Awaited<TConfig>`, not `TConfig` (TS can't rule out TConfig itself being Promise-shaped
  // for some future instantiation) — which then rejects every later `config = next` where
  // `next: TConfig`. loadLayerConfig<T>(id, defaults: T): Promise<T> is instantiated with
  // T = TConfig here, so the two are the same type; the cast just says so.
  let config = (await loadLayerConfig(layer.id, layer.defaults)) as TConfig
  let cache: { key: string; data: TDatum[] } | null = null
  let enabled = new URLSearchParams(window.location.search).get(layer.id) !== 'off'
  let panel: SettingsPanelHandle | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  // One button for both "is this layer on" (the is-on accent, kept live even while the
  // panel is closed) and "configure it" (click opens the panel below) — the enable/disable
  // switch that used to be this button's own click handler is now the panel's first row.
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

  // `chart` is narrowed to non-null above, but that narrowing only survives into a closure
  // for a `const` (arrow) function — a hoisted `function` declaration is treated as
  // reachable from anywhere in scope, including hypothetically before the guard ran, so TS
  // widens `chart` back to `Chart | null` inside one. Every helper below is a `const`
  // precisely to keep the narrowing.
  const closePanel = (): void => {
    panel?.close()
    panel = null
  }

  const clearOverlays = (): void => {
    chart.removeOverlay({ groupId: layer.id })
  }

  const paint = (data: TDatum[], ctx: LayerContext): void => {
    clearOverlays()
    if (data.length === 0) return
    const overlays = layer.toOverlays(data, ctx, config).map((overlay) => ({
      ...overlay,
      groupId: layer.id
    }))
    chart.createOverlay(overlays)
  }

  const redraw = async (): Promise<void> => {
    if (!enabled) return
    const symbol = chartPro.getSymbol()
    const available = layer.available(symbol, symbolVendor(symbol))
    layerButton.hidden = !available
    if (!available) {
      closePanel()
      clearOverlays()
      return
    }
    const ctx = buildContext(chart, symbol)
    if (!ctx) return

    const key = layer.queryKey(ctx, config)
    if (cache && cache.key === key) {
      paint(cache.data, ctx)
      return
    }
    try {
      const data = await layer.fetch(ctx, config)
      cache = { key, data }
      paint(data, ctx)
    } catch (err) {
      console.error(`[chartlayers] ${layer.id} fetch failed`, err)
    }
  }

  const scheduleRedraw = (): void => {
    if (!enabled) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void redraw()
    }, layer.debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  // A style-only change (line width, color, pattern, an emphasis curve) restyles instantly
  // from the cached fetch — no request. A change to a lever baked into queryKey (which
  // intervals, whether to include spent levels) misses the cache and refetches.
  const onConfigChange = (next: TConfig): void => {
    config = next
    saveLayerConfig(layer.id, config)
    if (cache) {
      const ctx = buildContext(chart, chartPro.getSymbol())
      if (ctx && layer.queryKey(ctx, config) === cache.key) {
        paint(cache.data, ctx)
        return
      }
    }
    void redraw()
  }

  const onToggleEnabled = (next: boolean): void => {
    enabled = next
    applyToggleState()
    if (enabled) void redraw()
    else clearOverlays()
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

  attachToSlot(chartPro, 'toolbar', layerButton)
  chart.subscribeAction('onVisibleRangeChange', scheduleRedraw)

  applyToggleState()
  scheduleRedraw()
}
