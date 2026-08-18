import type { Chart } from 'klinecharts'
import type { ChartProPane, KLineChartPro, SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import { openSettingsPanel, type SettingsPanelHandle } from './settings'
import { loadLayerConfig, saveLayerConfig } from './store'
import type { ChartLayer, LayerContext, LayerWindow } from './types'

// Generic multi-pane lifecycle for a ChartLayer (types.ts): one shared toolbar button that
// opens a settings panel (enable/disable is that panel's first row, not a separate click
// target — see settings.ts), applied independently to every currently-live pane of the wall
// (src/state/wall.svelte.ts) — coverage-gated enablement, debounced redraw on pan/zoom/
// symbol/period/price-axis change, and a per-pane record of which price/time window has
// been fetched so a wider view loads only the part it is missing, all scoped per pane.
//
// `attach` and `sync` are separate calls because `sync` must exist before a `KLineChartPro`
// does, so it can be supplied as that constructor's own `onPanesChange` option
// (client/index.ts) — the wall reports which panes are live from the moment the first one
// mounts, earlier than the constructor call returns.

const DEFAULT_DEBOUNCE_MS = 400

// The pane overlays are anchored to, and so the one whose price axis defines the band a
// price-anchored layer has to cover. klinecharts' own PaneIdConstants.CANDLE, which the
// package does not export.
const CANDLE_PANE_ID = 'candle_pane'

// The server computes over the full price history, so an unbounded query returns bands
// nowhere near the current price. Every price-anchored layer needs a window around the
// visible range, not the whole loaded history — kept here rather than per-layer because it
// is about how much of the chart is on screen, not about what any one layer computes.
const PRICE_WINDOW_FRACTION = 0.06

// How far past the window it actually needs a fetch reaches, as a fraction of the visible
// span on each side. Bought once and kept: the next small pan or rescale then lands inside
// what the pane already holds and repaints without a request. Half a screen in both axes
// keeps the held rectangle at ~2x the view per axis rather than unbounded, and measuring it
// against the VISIBLE span rather than the accumulated one means a long session of panning
// grows the window a screen at a time instead of doubling it per fetch.
//
// This bounds WHICH DATA a pane has, and is deliberately not the same number as how far off
// screen a layer draws what it has (levels/layer.ts's DRAW_MARGIN_SPANS): a level whose life
// crosses the view was fetched by that crossing, and its line then has to run well past the
// pane or the drawing's own edge shows up as a wall when the view moves.
const PREFETCH_FRACTION = 0.5

// How often a pane's price axis is sampled — see startAxisWatch on why sampling, rather
// than a subscription, is what notices a rescale.
const AXIS_POLL_MS = 200

// A pane's accumulated data is a snapshot of a server-side computation that keeps running:
// levels are recomputed as new candles close, so what a pane holds has to expire even while
// the user stays inside the window it was fetched for.
const CACHE_TTL_MS = 5 * 60_000

// Puts `element` in one of the library's two slots (src/types.ts ChartPro.getSlot) and
// keeps it there. Both slots stay wall-global, not per-pane. There are two separate timing
// problems here, and conflating them is what silently detaches a control for good.
//
// Getting it there the first time is a WAIT, not a mutation. Every caller runs in the same
// tick as the KLineChartPro constructor, and at that point every slot is null: slots are
// `bind:this` targets, and `mount()` inserts their elements into the DOM synchronously but
// only SCHEDULES the effect that assigns them. So the first attempt always misses, and
// there is no later mutation of that DOM to wait for — it is already built. Poll until
// getSlot() resolves, the same answer whenChartReady gave the identical problem for
// getChart(), and never make anything below conditional on that first attempt succeeding.
//
// Keeping it there is the mutation half: 'rail-footer''s own element is destroyed and
// recreated every time the drawing toolbar toggles off and back on — it lives inside
// ChartPro.svelte's `{#if drawingBarVisible}` — so re-parent into whichever instance of the
// slot currently exists rather than attaching once, or the control vanishes for good the
// first time someone hides the drawing tools instead of merely hiding with it.
export function attachToSlot(
  chartPro: KLineChartPro,
  slotName: 'toolbar' | 'rail-footer',
  element: HTMLElement
): void {
  const tryAttach = (): boolean => {
    const slot = chartPro.getSlot(slotName)
    if (!slot) return false
    if (element.parentElement !== slot) slot.appendChild(element)
    return true
  }

  if (!tryAttach()) {
    // Give up rather than spin forever if the component genuinely failed to build.
    const deadline = performance.now() + 5_000
    const poll = (): void => {
      if (tryAttach() || performance.now() > deadline) return
      requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  }

  // The container, not a root reached through the slot: it exists from the moment the
  // constructor returns, so this is registered unconditionally rather than only once some
  // attempt has already found a slot to navigate up from.
  new MutationObserver(() => {
    tryAttach()
  }).observe(chartPro.getContainer(), { childList: true, subtree: true })
}

// The price band on screen, which is NOT the price range of the visible bars: rescaling the
// price axis (dragging it, or dragging the chart body once it has stopped auto-fitting)
// moves the two apart, and it is exactly that case where the bars say nothing about which
// prices a layer now has to cover.
function visiblePriceBand(chart: Chart): { low: number; high: number } | null {
  // The pane's default axis is the one overlays without an explicit yAxisId are drawn
  // against, and it is the first the pane hands back (DrawPane keeps the first axis created
  // as its default).
  const yAxis = chart.getYAxes({ paneId: CANDLE_PANE_ID })[0]
  if (!yAxis) return null
  const range = yAxis.getRange()
  // `from`/`to` are prices whatever the axis type is: a percentage or logarithm axis keeps
  // its own transformed coordinates in realFrom/realTo, so this stays right when the user
  // switches the axis to % or log.
  const low = Math.min(range.from, range.to)
  const high = Math.max(range.from, range.to)
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null
  return { low, high }
}

// Fallback for the window between a pane mounting and its axis having a range — the
// original behaviour, and still a sane band whenever the axis cannot be read.
function visibleBarBand(chart: Chart): { low: number; high: number } | null {
  const data = chart.getDataList()
  const range = chart.getVisibleRange()
  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
    const bar = data[i]
    if (bar.low < low) low = bar.low
    if (bar.high > high) high = bar.high
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null
  return { low, high }
}

// The price band and time window every price-anchored layer needs covered, scoped to what
// is actually on screen rather than every bar paginated in so far.
function buildContext(chart: Chart, symbol: SymbolInfo): LayerContext | null {
  const data = chart.getDataList()
  const range = chart.getVisibleRange()
  const visible = data.slice(Math.max(0, range.realFrom), Math.max(0, range.realTo) + 1)
  if (visible.length === 0) return null

  const band = visiblePriceBand(chart) ?? visibleBarBand(chart)
  if (!band) return null

  const pad = Math.max((band.high - band.low) * PRICE_WINDOW_FRACTION, band.high * 1e-4)
  return {
    chart,
    symbol,
    vendor: symbolVendor(symbol),
    priceMin: band.low - pad,
    priceMax: band.high + pad,
    from: visible[0].timestamp,
    to: visible[visible.length - 1].timestamp
  }
}

function windowOf(ctx: LayerContext): LayerWindow {
  return { priceMin: ctx.priceMin, priceMax: ctx.priceMax, from: ctx.from, to: ctx.to }
}

function contains(outer: LayerWindow, inner: LayerWindow): boolean {
  return (
    outer.priceMin <= inner.priceMin &&
    outer.priceMax >= inner.priceMax &&
    outer.from <= inner.from &&
    outer.to >= inner.to
  )
}

function union(a: LayerWindow, b: LayerWindow): LayerWindow {
  return {
    priceMin: Math.min(a.priceMin, b.priceMin),
    priceMax: Math.max(a.priceMax, b.priceMax),
    from: Math.min(a.from, b.from),
    to: Math.max(a.to, b.to)
  }
}

function withPrefetchMargin(target: LayerWindow, visible: LayerWindow): LayerWindow {
  const pricePad = (visible.priceMax - visible.priceMin) * PREFETCH_FRACTION
  const timePad = (visible.to - visible.from) * PREFETCH_FRACTION
  return {
    priceMin: target.priceMin - pricePad,
    priceMax: target.priceMax + pricePad,
    from: target.from - timePad,
    to: target.to + timePad
  }
}

// `target` minus `loaded` as up to four rectangles: the price bands above and below what is
// held (each spanning target's full time span) plus, within the held band, the time spans
// before and after it. They tile the difference exactly, so fetching them and merging is
// equivalent to refetching `target` whole — and the caller only pays for the new ground.
// Requires `target` to contain `loaded`, which is what withPrefetchMargin(union(...)) gives.
function missingWindows(loaded: LayerWindow, target: LayerWindow): LayerWindow[] {
  const windows: LayerWindow[] = []
  if (target.priceMin < loaded.priceMin) windows.push({ ...target, priceMax: loaded.priceMin })
  if (target.priceMax > loaded.priceMax) windows.push({ ...target, priceMin: loaded.priceMax })
  const heldBand = { priceMin: loaded.priceMin, priceMax: loaded.priceMax }
  if (target.from < loaded.from) windows.push({ ...heldBand, from: target.from, to: loaded.from })
  if (target.to > loaded.to) windows.push({ ...heldBand, from: loaded.to, to: target.to })
  return windows
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

// What one pane has fetched so far: `data` is everything the layer returned for `window`,
// which grows as the view moves and is thrown away whenever `key` changes or `fetchedAt`
// ages out.
interface LayerCache<TDatum> {
  key: string
  data: TDatum[]
  window: LayerWindow
  fetchedAt: number
}

interface WiredPane<TDatum> {
  pane: ChartProPane
  chart: Chart
  cache: LayerCache<TDatum> | null
  timer: ReturnType<typeof setTimeout> | null
  onRangeChange: () => void
  /** Last price band seen by the axis watcher, as a change-detection signature. */
  axisSignature: string
  /** Bumped per fetch so a redraw that resolves after a newer one started drops its result
   * instead of overwriting a cache built from different state. */
  generation: number
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

  // Disabled — never hidden — unless NONE of the currently-live panes have coverage: the
  // control keeps its place in the toolbar so the wall's layout doesn't shift as symbols
  // change, and the greyed-out button says "not here" rather than leaving the user to
  // wonder where it went. A wall with even one eligible pane stays enabled, rather than
  // going dead whenever the ACTIVE pane happens to be on an ineligible symbol.
  const updateAvailability = (): void => {
    const available = [...wired.values()].some((entry) => {
      const symbol = entry.pane.getSymbol()
      return layer.available(symbol, symbolVendor(symbol))
    })
    layerButton.disabled = !available
    layerButton.title = available ? '' : `${layer.label}: not available for this symbol`
    // A panel left open over a pane that has just switched to an ineligible symbol would
    // otherwise outlive the button that owns it.
    if (!available) closePanel()
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
    if (overlays.length > 0) entry.chart.createOverlay(overlays)
  }

  // Adjacent windows share an edge, and a level sitting on one is returned by both, so a
  // merge is a union by the layer's own datum identity rather than a concatenation.
  const merge = (held: TDatum[], fetched: TDatum[]): TDatum[] => {
    const seen = new Set(held.map((datum) => layer.datumKey(datum)))
    const merged = held.slice()
    for (const datum of fetched) {
      const key = layer.datumKey(datum)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(datum)
    }
    return merged
  }

  const redraw = async (entry: WiredPane<TDatum>): Promise<void> => {
    // Ahead of the enabled check: whether the button is reachable follows the wall's
    // symbols, not whether the layer is currently drawing. Panel closing lives there too,
    // so a pane on an ineligible symbol no longer closes a panel the rest of the wall
    // still has a live button for.
    updateAvailability()
    if (!enabled) return
    const symbol = entry.pane.getSymbol()
    if (!layer.available(symbol, symbolVendor(symbol))) {
      clearOverlays(entry)
      return
    }
    const ctx = buildContext(entry.chart, symbol)
    if (!ctx) return

    const key = layer.cacheKey(ctx, config)
    const needed = windowOf(ctx)
    let held = entry.cache
    if (held && (held.key !== key || Date.now() - held.fetchedAt > CACHE_TTL_MS)) held = null

    // Everything on screen is already in hand: restyle from it, no request. This is the
    // common case while panning and while rescaling the price axis within the band the
    // pane fetched with its prefetch margin.
    if (held && contains(held.window, needed)) {
      paint(entry, held.data, ctx)
      return
    }

    const target = withPrefetchMargin(held ? union(held.window, needed) : needed, needed)
    const requests = held ? missingWindows(held.window, target) : [target]
    const generation = ++entry.generation
    try {
      const fetched = await Promise.all(requests.map((request) => layer.fetch(ctx, config, request)))
      // A newer redraw started while this one was in flight — its own fetch is authoritative
      // about both the data and the window it covers, so this result is dropped whole.
      if (generation !== entry.generation) return
      const data = merge(held?.data ?? [], fetched.flat())
      // Dated by the OLDEST fetch it still contains, not by this one: a pane that keeps
      // extending its window would otherwise renew the whole set on every extension and
      // never expire the part that was fetched first.
      entry.cache = { key, data, window: target, fetchedAt: held?.fetchedAt ?? Date.now() }
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

  // Pan and zoom raise onVisibleRangeChange, but rescaling the PRICE axis raises nothing:
  // klinecharts' ActionType has no y-axis member, and the drag calls YAxis.setRange
  // directly. Sampling each pane's band is therefore the only way to notice that the view
  // now reaches prices the pane never fetched. A sample that has not moved costs one
  // getRange call and schedules nothing; one that has usually resolves to a repaint from
  // what the pane already holds, and only reaches the network when the band grew past it.
  let axisTimer: ReturnType<typeof setInterval> | null = null

  const pollPriceAxes = (): void => {
    if (!enabled) return
    for (const entry of wired.values()) {
      const band = visiblePriceBand(entry.chart)
      const signature = band ? `${band.low}|${band.high}` : ''
      if (signature === entry.axisSignature) continue
      entry.axisSignature = signature
      scheduleRedraw(entry)
    }
  }

  const startAxisWatch = (): void => {
    if (axisTimer === null) axisTimer = setInterval(pollPriceAxes, AXIS_POLL_MS)
  }

  const stopAxisWatch = (): void => {
    if (axisTimer === null) return
    clearInterval(axisTimer)
    axisTimer = null
  }

  // A style-only change (line width, color, pattern, an emphasis curve) restyles instantly
  // from each pane's own accumulated data — no request. A change to a lever baked into
  // cacheKey (which intervals, whether to include spent levels) misses the cache and
  // refetches, per pane, since two panes on different symbols/intervals have independently
  // distinct keys.
  const onConfigChange = (next: TConfig): void => {
    config = next
    saveLayerConfig(layer.id, config)
    for (const entry of wired.values()) {
      if (entry.cache) {
        const ctx = buildContext(entry.chart, entry.pane.getSymbol())
        if (
          ctx &&
          layer.cacheKey(ctx, config) === entry.cache.key &&
          contains(entry.cache.window, windowOf(ctx))
        ) {
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
          onRangeChange: () => {},
          axisSignature: '',
          generation: 0
        }
        // Pan, zoom and every data load land here, which covers symbol and period
        // switches too. The price axis has no equivalent — see pollPriceAxes.
        entry.onRangeChange = () => scheduleRedraw(entry)
        chart.subscribeAction('onVisibleRangeChange', entry.onRangeChange)
        wired.set(pane.id, entry)
        if (configLoaded) scheduleRedraw(entry)
      }
      updateAvailability()
      if (wired.size > 0) startAxisWatch()
      else stopAxisWatch()
    }
  }
}
