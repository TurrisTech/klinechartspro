import type { Chart } from 'klinecharts'
import type { ChartProPane, ChartProSlot, KLineChartPro, SymbolInfo } from '../../src'
import { symbolVendor } from '../symbols'
import { overlaySignature } from './paint'
import { layerConfigCodec, type StoredLayerConfig } from './persist'
import { loadLayerConfig } from './store'
import type { ChartLayer, LayerContext, LayerWindow } from './types'
import { contains, missingWindows, PRICE_WINDOW_FRACTION, targetWindow } from './window'

// Generic multi-pane lifecycle for a ChartLayer (types.ts), applied independently to every
// currently-live pane of the wall (src/state/wall.svelte.ts): coverage-gated drawing,
// debounced redraw on pan/zoom/symbol/period/price-axis change, and a per-pane record of which
// price/time window has been fetched so a wider view loads only the part it is missing.
//
// A layer is drawn on a pane exactly while that pane carries the layer's indicator template,
// visible -- the picker adds it, the legend hides or removes it, the indicator manager does
// either across panes (plugin.ts registers the template and owns the settings UI). There is
// no wall-wide switch: until 2026-10-03 each layer was one toolbar button and one config for
// the whole wall, which is not how anything else on the chart is turned on. Settings are per
// pane, kept by pane index like every indicator plugin's, and persisted in the wall document.
//
// `sync` must exist before a `KLineChartPro` does, so it can be called from that
// constructor's own `onPanesChange` option (client/index.ts) — the wall reports which panes
// are live from the moment the first one mounts, earlier than the constructor call returns.

const DEFAULT_DEBOUNCE_MS = 400

// The pane overlays are anchored to, and so the one whose price axis defines the band a
// price-anchored layer has to cover. klinecharts' own PaneIdConstants.CANDLE, which the
// package does not export.
const CANDLE_PANE_ID = 'candle_pane'

// How often each pane is sampled -- whether it carries the layer's indicator, and where its
// price axis is. See startWatch on why sampling, rather than a subscription, is what notices
// either.
const POLL_MS = 200

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

export interface LayerController<TConfig extends object = object> {
  /** The layer this draws: its `id` keys its settings, its `label` names it on screen. */
  readonly layer: ChartLayer<unknown, TConfig>
  /** The klinecharts indicator template whose presence on a pane turns the layer on there. */
  readonly template: string
  /** Reconciles this layer's per-pane wiring against the wall's currently-live panes. Called
   * from `ChartProOptions.onPanesChange`, with the panes in wall order -- a pane's position is
   * what its settings are kept under. */
  sync(panes: ChartProPane[]): void
  /** Forget every pane's fetched data and redraw: the read clock moved (a replay step), so
   * what the server answers for the same window has changed. */
  invalidate(): void
  /** One pane's settings: its own, or for a pane never configured the baseline (store.ts). */
  configFor(paneIndex: number): TConfig
  /** Replace one pane's settings (normalised here) and redraw that pane -- from what it
   * already holds when only the styling changed. */
  setConfig(paneIndex: number, config: unknown): void
  /** Replace every pane's settings with the wall document's, as `snapshot` wrote them. */
  hydrate(stored: Record<number, unknown>): void
  /** Each configured pane's settings that differ from the defaults; an untouched pane is
   * absent, so it adds nothing to the wall document. */
  snapshot(): Record<number, StoredLayerConfig>
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
  /** Position in the wall -- what this pane's settings are kept under. */
  paneIndex: number
  chart: Chart
  /** Whether the pane carries the layer's indicator, visible, as of the last sample. */
  on: boolean
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
  layer: ChartLayer<TDatum, TConfig>,
  template: string
): LayerController<TConfig> {
  const codec = layerConfigCodec(layer.defaults, layer.fields)
  const configs: Record<number, TConfig> = {}
  // What a pane never configured draws with. Until the layers became indicators their
  // settings were one wall-wide document (store.ts), and the settings a user chose there are
  // where every pane of theirs starts -- read once, never written again.
  let baseline: TConfig = layer.defaults
  let baselineLoaded = false
  const wired = new Map<string, WiredPane<TDatum>>()

  const configFor = (paneIndex: number): TConfig => configs[paneIndex] ?? baseline

  // Whether the pane carries the layer's indicator and it is not hidden. klinecharts is the
  // source of truth: the picker, the legend and the indicator manager all change a pane's
  // indicators without telling anyone, which is why this is sampled (startWatch).
  const shown = (entry: WiredPane<TDatum>): boolean => {
    try {
      return entry.chart.getIndicators({ name: template }).some((indicator) => indicator.visible !== false)
    } catch {
      return false
    }
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
    const config = configFor(entry.paneIndex)
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
    if (!entry.on) return
    const symbol = entry.pane.getSymbol()
    if (!layer.available(symbol, symbolVendor(symbol))) {
      clearOverlays(entry)
      return
    }
    const ctx = buildContext(entry.chart, symbol)
    if (!ctx) return

    const config = configFor(entry.paneIndex)
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
      // about both the data and the window it covers, so this result is dropped whole. So is
      // one that lands after the indicator came off the pane.
      if (generation !== entry.generation || !entry.on) return
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
    if (!entry.on) return
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

  const turnOff = (entry: WiredPane<TDatum>): void => {
    entry.on = false
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    // Dropped rather than kept for a re-add: a pane that put the indicator away may be one
    // of a dozen, and what it held can be most of a book.
    entry.cache = null
    entry.generation++
    clearOverlays(entry)
  }

  // Two things raise nothing a subscription could hear. An indicator added, hidden or removed
  // through the picker, the legend or the indicator manager is klinecharts' own business. And
  // rescaling the PRICE axis: klinecharts' ActionType has no y-axis member, and the drag
  // calls YAxis.setRange directly, so sampling each pane's band is the only way to notice
  // that the view now reaches prices the pane never fetched. A sample where neither moved
  // costs two cheap calls and schedules nothing; a moved band usually resolves to a repaint
  // from what the pane already holds, and only reaches the network when it grew past it.
  let watchTimer: ReturnType<typeof setInterval> | null = null

  const sample = (): void => {
    // Nothing is drawn before the baseline is known: a pane drawn with the defaults first
    // would fetch twice whenever the saved baseline asks for different timeframes.
    if (!baselineLoaded) return
    for (const entry of wired.values()) {
      const on = shown(entry)
      const band = on ? visiblePriceBand(entry.chart) : null
      const signature = band ? `${band.low}|${band.high}` : ''
      if (on !== entry.on) {
        if (!on) {
          turnOff(entry)
          continue
        }
        // Drawn at once rather than debounced: this is the user's own click. The band is
        // taken now so the next sample does not schedule a second fetch while this one is
        // still in flight.
        entry.on = true
        entry.axisSignature = signature
        void redraw(entry)
        continue
      }
      if (!entry.on || signature === entry.axisSignature) continue
      entry.axisSignature = signature
      scheduleRedraw(entry)
    }
  }

  const startWatch = (): void => {
    if (watchTimer === null) watchTimer = setInterval(sample, POLL_MS)
  }

  const stopWatch = (): void => {
    if (watchTimer === null) return
    clearInterval(watchTimer)
    watchTimer = null
  }

  // A style-only change (line width, color, pattern, an emphasis curve) restyles instantly
  // from the pane's own accumulated data — no request. A change to a lever baked into
  // cacheKey (which intervals, whether to include spent levels) misses the cache and
  // refetches.
  const restyle = (entry: WiredPane<TDatum>): void => {
    if (!entry.on) return
    if (entry.cache) {
      const ctx = buildContext(entry.chart, entry.pane.getSymbol())
      if (
        ctx &&
        layer.cacheKey(ctx, configFor(entry.paneIndex)) === entry.cache.key &&
        contains(entry.cache.window, windowOf(ctx))
      ) {
        paint(entry, entry.cache.data, ctx)
        return
      }
    }
    void redraw(entry)
  }

  // Never throws (loadLayerConfig's own contract). Panes are drawn from the first sample
  // after this resolves.
  void (async () => {
    baseline = codec.normalise(await loadLayerConfig(layer.id, layer.defaults))
    baselineLoaded = true
    sample()
  })()

  return {
    layer: layer as ChartLayer<unknown, TConfig>,
    template,
    invalidate(): void {
      for (const entry of wired.values()) {
        entry.cache = null
        void redraw(entry)
      }
    },
    configFor,
    setConfig(paneIndex: number, config: unknown): void {
      configs[paneIndex] = codec.normalise(config)
      for (const entry of wired.values()) if (entry.paneIndex === paneIndex) restyle(entry)
    },
    hydrate(stored: Record<number, unknown>): void {
      // Replaces, as every plugin's paneState.hydrate does: it is also how panes changing
      // places on the wall re-key these (PluginHost.reorderPanes), and the sync that follows
      // restyles each moved pane from the config now under its new index.
      for (const index of Object.keys(configs)) delete configs[Number(index)]
      for (const [index, value] of Object.entries(stored)) {
        const config = codec.fromStored(value)
        if (config) configs[Number(index)] = config
      }
    },
    snapshot(): Record<number, StoredLayerConfig> {
      const out: Record<number, StoredLayerConfig> = {}
      for (const [index, config] of Object.entries(configs)) {
        const stored = codec.toStored(config)
        if (stored) out[Number(index)] = stored
      }
      return out
    },
    sync(panes: ChartProPane[]): void {
      const live = new Map(panes.map((pane, index) => [pane.id, { pane, index }]))
      for (const [id, entry] of wired) {
        const next = live.get(id)
        if (next && next.pane.getChart() === entry.chart) {
          // A layout change can renumber panes without remounting their charts, and the
          // number is what this pane's settings are kept under.
          if (entry.paneIndex !== next.index) {
            entry.paneIndex = next.index
            restyle(entry)
          }
          continue
        }
        if (entry.timer) clearTimeout(entry.timer)
        entry.generation++
        try {
          entry.chart.unsubscribeAction('onVisibleRangeChange', entry.onRangeChange)
        } catch {
          // chart already disposed
        }
        wired.delete(id)
      }
      for (const [id, { pane, index }] of live) {
        if (wired.has(id)) continue
        const chart = pane.getChart()
        const entry: WiredPane<TDatum> = {
          pane,
          paneIndex: index,
          chart,
          on: false,
          cache: null,
          timer: null,
          onRangeChange: () => {},
          axisSignature: '',
          generation: 0,
          painted: '',
          scheduledAt: 0
        }
        // Pan, zoom and every data load land here, which covers symbol and period
        // switches too. The price axis has no equivalent — see sample.
        entry.onRangeChange = () => scheduleRedraw(entry)
        chart.subscribeAction('onVisibleRangeChange', entry.onRangeChange)
        wired.set(id, entry)
      }
      if (wired.size > 0) {
        startWatch()
        sample()
      } else {
        stopWatch()
      }
    }
  }
}
