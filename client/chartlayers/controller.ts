import type { Chart } from 'klinecharts'
import type { ChartProPane, ChartProSlot, KLineChartPro, SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import { overlaySignature } from './paint'
import { openSettingsPanel, type SettingsPanelHandle } from './settings'
import { loadLayerConfig, saveLayerConfig } from './store'
import type { ChartLayer, LayerContext, LayerWindow } from './types'
import { contains, missingWindows, PRICE_WINDOW_FRACTION, targetWindow } from './window'

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

// How often a pane's price axis is sampled — see startAxisWatch on why sampling, rather
// than a subscription, is what notices a rescale.
const AXIS_POLL_MS = 200

// Ceiling on how long the redraw debounce can defer. The debounce is trailing, so a stream
// of events closer together than DEFAULT_DEBOUNCE_MS never lets it fire — and that is the
// normal state of a live chart, where every tick raises onVisibleRangeChange (klinecharts
// re-adjusts the visible range even when the last bar is merely updated) and nudges the
// autoscaled price axis for the axis watcher to notice. Without a ceiling a pane panned
// during an active session would sit on the levels it had before the pan until the market
// went quiet. The redraw itself is cheap when nothing moved (see paint.ts).
const MAX_DEBOUNCE_MS = 2_000

// Fallback expiry for a layer that declares no `staleAt`: a pane's accumulated data is a
// snapshot of a server-side computation that keeps running, so it has to expire even while
// the user stays inside the window it was fetched for. A layer that knows WHEN its data can
// change says so instead and is not re-fetched on a timer at all — see types.ts.
const CACHE_TTL_MS = 5 * 60_000

// Puts `element` in one of the library's slots (src/types.ts ChartProSlot) and keeps it
// there. Every slot stays wall-global, not per-pane. There are two separate timing
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
/** Returns a disposer. Switching workspaces tears the chart down and builds a new one against
 * the SAME container element, so an observer left running would accumulate one per switch,
 * all watching the same live element -- and the element it re-attaches would be one belonging
 * to a chart that no longer exists. */
export function attachToSlot(
  chartPro: KLineChartPro,
  slotName: ChartProSlot,
  element: HTMLElement
): () => void {
  let detached = false
  const tryAttach = (): boolean => {
    if (detached) return true
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
  const observer = new MutationObserver(() => {
    tryAttach()
  })
  observer.observe(chartPro.getContainer(), { childList: true, subtree: true })

  return () => {
    detached = true
    observer.disconnect()
    element.remove()
  }
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

export interface LayerController {
  /** Attaches the layer's single toolbar button once a KLineChartPro instance exists. Call
   * once, right after construction. */
  attach(chartPro: KLineChartPro): void
  /** Removes that button, closes any open settings panel, and stops watching the chart's DOM.
   * Paired with attach() across a chart TEARDOWN -- a workspace switch builds a whole new
   * KLineChartPro against the same container, and an undetached controller would keep
   * re-attaching a button belonging to the chart that just went away. */
  detach(): void
  /** Reconciles this layer's per-pane wiring against the wall's currently-live panes. Pass
   * straight through as `ChartProOptions.onPanesChange` — built before the chart exists so
   * its `sync` can be supplied at construction time. */
  sync(panes: ChartProPane[]): void
  /** Forget every pane's fetched data and redraw: the read clock moved (a replay step), so
   * what the server answers for the same window has changed. */
  invalidate(): void
}

// What one pane has fetched so far: `data` is everything the layer returned for `window`,
// which grows as the view moves and is thrown away whenever `key` changes or the clock
// passes `staleAt`.
interface LayerCache<TDatum> {
  key: string
  data: TDatum[]
  window: LayerWindow
  fetchedAt: number
  /** When what the server would answer for this window can first differ from what is held.
   * From the layer's `staleAt` where it declares one — levels can only change when a 1W or
   * 1M candle closes, which is a fact about the data, not a guess about elapsed time. */
  staleAt: number
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
  /** `overlaySignature` of what is currently on the chart for this layer; `''` means
   * nothing of ours is. A redraw that would rebuild the identical set is skipped. */
  painted: string
  /** When the pending debounce was first scheduled, so a run of events that never stops
   * long enough for the trailing edge still gets a redraw within MAX_DEBOUNCE_MS. */
  scheduledAt: number
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
    if (entry.painted === '') return
    entry.chart.removeOverlay({ groupId: layer.id })
    entry.painted = ''
  }

  // Build the overlays, then compare them with what is already drawn and touch the chart
  // only if they differ (paint.ts). The build is pure JS over what the pane already holds;
  // the remove/create pair is a full teardown and rebuild of several hundred overlays plus
  // two chart invalidations, and on a live chart the redraw that reaches here is several
  // times a second and almost always draws the same lines.
  const paint = (entry: WiredPane<TDatum>, data: TDatum[], ctx: LayerContext): void => {
    const overlays =
      data.length === 0
        ? []
        : layer.toOverlays(data, ctx, config).map((overlay) => ({ ...overlay, groupId: layer.id }))
    const signature = overlaySignature(overlays)
    if (signature === entry.painted) return
    entry.chart.removeOverlay({ groupId: layer.id })
    if (overlays.length > 0) entry.chart.createOverlay(overlays)
    entry.painted = signature
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

  // When data fetched at `fetchedAt` can first be wrong. A layer that knows the answer says
  // so; one that doesn't gets the timer.
  const staleAt = (fetchedAt: number, ctx: LayerContext): number =>
    layer.staleAt ? layer.staleAt(fetchedAt, ctx) : fetchedAt + CACHE_TTL_MS

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
    if (held && (held.key !== key || Date.now() >= held.staleAt)) held = null

    // Everything on screen is already in hand: restyle from it, no request. This is the
    // common case while panning and while rescaling the price axis within the band the
    // pane fetched with its prefetch margin.
    if (held && contains(held.window, needed)) {
      paint(entry, held.data, ctx)
      return
    }

    const target = targetWindow(held?.window ?? null, needed)
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
      const fetchedAt = held?.fetchedAt ?? Date.now()
      // Recomputed on every fetch, not carried over with `fetchedAt`: a layer whose horizon
      // depends on what the server has computed learns that from the answer it just got, so
      // an extension of the window is also the moment its horizon can move.
      entry.cache = { key, data, window: target, fetchedAt, staleAt: staleAt(fetchedAt, ctx) }
      paint(entry, data, ctx)
    } catch (err) {
      console.error(`[chartlayers] ${layer.id} fetch failed for pane ${entry.pane.id}`, err)
    }
  }

  const scheduleRedraw = (entry: WiredPane<TDatum>): void => {
    if (!enabled) return
    const now = Date.now()
    if (entry.timer === null) entry.scheduledAt = now
    else clearTimeout(entry.timer)
    // Trailing debounce, but never deferred past MAX_DEBOUNCE_MS from the first event of
    // the run: a live chart produces events faster than the debounce window forever, and a
    // purely trailing one would then never fire at all.
    const wait = Math.max(
      0,
      Math.min(layer.debounceMs ?? DEFAULT_DEBOUNCE_MS, entry.scheduledAt + MAX_DEBOUNCE_MS - now)
    )
    entry.timer = setTimeout(() => {
      entry.timer = null
      void redraw(entry)
    }, wait)
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

  const invalidate = (): void => {
    for (const entry of wired.values()) {
      entry.cache = null
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

  let detachButton: (() => void) | null = null

  return {
    invalidate,
    attach(chartPro: KLineChartPro): void {
      detachButton?.()
      detachButton = attachToSlot(chartPro, 'toolbar', layerButton)
    },
    detach(): void {
      closePanel()
      detachButton?.()
      detachButton = null
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
          generation: 0,
          painted: '',
          scheduledAt: 0
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
