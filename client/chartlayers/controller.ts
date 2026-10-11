import type { Chart } from 'klinecharts'
import type { ChartProPane, SymbolInfo } from '../../src'
import { onViewMoved } from '../chartview'
import { symbolVendor } from '../symbols'
import { overlaySignature } from './paint'
import { type LayerConfigCodec, layerConfigCodec } from './persist'
import { loadLayerConfig } from './store'
import type { ChartLayer, LayerContext, LayerWindow } from './types'
import { contains, missingWindows, PRICE_WINDOW_FRACTION, targetWindow } from './window'

// How a ChartLayer (types.ts) draws on a pane: coverage-gated drawing, a debounced redraw on
// pan/zoom/data load/price-axis change, and a record of which price/time window the pane has
// fetched, so a wider view loads only the part it is missing.
//
// A layer draws on a pane exactly while that pane carries the layer's indicator template,
// visible. That is a BINDING (plugin.ts): the plugin host binds the template like any other
// plugin indicator, hands it the pane's settings, rebinds when they -- or the pane's symbol,
// timeframe or place on the wall -- change, and releases it when the indicator goes. Each
// binding attaches a VIEW here for as long as it lives. Until 2026-10-11 this was a
// controller per layer that followed the wall's panes itself, sampling every one of them
// five times a second for the template, with a settings store of its own beside the host's.
//
// What a pane has fetched and drawn is kept per CHART, not per view, so the binding that
// replaces another on the same pane (a settings edit, a symbol change) starts from it: a
// style-only edit restyles from what is held without a request, and identical overlays are not
// torn down and rebuilt. The host attaches the new view before it releases the old one; a view
// released after it was replaced leaves the pane's hold to its successor.

const DEFAULT_DEBOUNCE_MS = 400

// The pane overlays are anchored to, and so the one whose price axis defines the band a
// price-anchored layer has to cover. klinecharts' own PaneIdConstants.CANDLE, which the
// package does not export.
const CANDLE_PANE_ID = 'candle_pane'

// How often a view samples its pane -- whether its indicator is shown, and where the price
// axis is. See `sample` on why sampling, rather than a subscription, is what notices either.
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
  /** The layer's settings as the wall document stores them (persist.ts). */
  readonly codec: LayerConfigCodec<TConfig>
  /** What a pane never configured draws with: the wall-wide settings of the toolbar era
   * (store.ts) once `ready`, the defaults before. */
  baseline(): TConfig
  /** Resolves once the baseline is read; never rejects. Nothing should draw before it, or a
   * pane drawn with the defaults first fetches twice whenever the baseline asks for different
   * timeframes. */
  readonly ready: Promise<void>
  /** Draws the layer on `pane` with `config` while the binding of `indicatorId` lives there.
   * Returns the release. */
  attach(pane: ChartProPane, indicatorId: string, config: TConfig): () => void
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

/** What a pane holds for the layer, across the views that follow one another on it. */
interface PaneHold<TDatum> {
  cache: LayerCache<TDatum> | null
  /** `overlaySignature` of what is currently on the chart for this layer; `''` means
   * nothing of ours is. A redraw that would rebuild the identical set is skipped. */
  painted: string
  /** The view drawing it now. */
  owner: object | null
}

export function createLayerController<TDatum, TConfig extends object>(
  layer: ChartLayer<TDatum, TConfig>,
  template: string
): LayerController<TConfig> {
  const codec = layerConfigCodec(layer.defaults, layer.fields)
  // What a pane never configured draws with. Until the layers became indicators their
  // settings were one wall-wide document (store.ts), and the settings a user chose there are
  // where every pane of theirs starts -- read once, never written again.
  let baseline: TConfig = layer.defaults
  // Never throws (loadLayerConfig's own contract).
  const ready = loadLayerConfig(layer.id, layer.defaults).then((stored) => {
    baseline = codec.normalise(stored)
  })
  const holds = new WeakMap<Chart, PaneHold<TDatum>>()
  const views = new Set<{ invalidate(): void }>()

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

  const attach = (pane: ChartProPane, indicatorId: string, config: TConfig): (() => void) => {
    const chart = pane.getChart()
    let hold = holds.get(chart)
    if (!hold) {
      hold = { cache: null, painted: '', owner: null }
      holds.set(chart, hold)
    }
    const owned = hold
    const self = {}
    owned.owner = self
    /** Whether the indicator is on the pane and shown, as of the last sample. */
    let on = false
    let released = false
    let timer: ReturnType<typeof setTimeout> | null = null
    /** When the pending debounce was first scheduled, so a run of events that never stops
     * long enough for the trailing edge still gets a redraw within MAX_DEBOUNCE_MS. */
    let scheduledAt = 0
    /** Bumped per fetch so a redraw that resolves after a newer one started drops its result
     * instead of overwriting a cache built from different state. */
    let generation = 0
    /** Last price band seen by the axis watcher, as a change-detection signature. */
    let axisSignature = ''

    // Whether the indicator is shown. klinecharts is the source of truth: the legend's eye
    // hides it without telling anyone, which is why this is sampled.
    const shown = (): boolean => {
      try {
        return chart.getIndicators({ id: indicatorId }).some((indicator) => indicator.visible !== false)
      } catch {
        return false
      }
    }

    const clearOverlays = (): void => {
      if (owned.painted === '') return
      try {
        chart.removeOverlay({ groupId: layer.id })
      } catch {
        // chart already disposed
      }
      owned.painted = ''
    }

    // Build the overlays, then compare them with what is already drawn and touch the chart
    // only if they differ (paint.ts). The build is pure JS over what the pane already holds;
    // the remove/create pair is a full teardown and rebuild of several hundred overlays plus
    // two chart invalidations, and on a live chart the redraw that reaches here is several
    // times a second and almost always draws the same lines.
    const paint = (data: TDatum[], ctx: LayerContext): void => {
      const overlays =
        data.length === 0
          ? []
          : layer.toOverlays(data, ctx, config).map((overlay) => ({ ...overlay, groupId: layer.id }))
      const signature = overlaySignature(overlays)
      if (signature === owned.painted) return
      chart.removeOverlay({ groupId: layer.id })
      if (overlays.length > 0) chart.createOverlay(overlays)
      owned.painted = signature
    }

    const redraw = async (): Promise<void> => {
      if (!on || released) return
      const symbol = pane.getSymbol()
      if (!layer.available(symbol, symbolVendor(symbol))) {
        clearOverlays()
        return
      }
      const ctx = buildContext(chart, symbol)
      if (!ctx) return

      const key = layer.cacheKey(ctx, config)
      const needed = windowOf(ctx)
      let held = owned.cache
      if (held && (held.key !== key || Date.now() >= held.staleAt)) held = null

      // Everything on screen is already in hand: restyle from it, no request. This is the
      // common case while panning, while rescaling the price axis within the band the pane
      // fetched with its prefetch margin, and after a style-only settings edit.
      if (held && contains(held.window, needed)) {
        paint(held.data, ctx)
        return
      }

      const target = targetWindow(held?.window ?? null, needed)
      const requests = held ? missingWindows(held.window, target) : [target]
      const mine = ++generation
      try {
        const fetched = await Promise.all(requests.map((request) => layer.fetch(ctx, config, request)))
        // A newer redraw started while this one was in flight — its own fetch is authoritative
        // about both the data and the window it covers, so this result is dropped whole. So is
        // one that lands after the indicator was hidden or the binding released.
        if (mine !== generation || !on || released) return
        const data = merge(held?.data ?? [], fetched.flat())
        // Dated by the OLDEST fetch it still contains, not by this one: a pane that keeps
        // extending its window would otherwise renew the whole set on every extension and
        // never expire the part that was fetched first.
        const fetchedAt = held?.fetchedAt ?? Date.now()
        // Recomputed on every fetch, not carried over with `fetchedAt`: a layer whose horizon
        // depends on what the server has computed learns that from the answer it just got, so
        // an extension of the window is also the moment its horizon can move.
        owned.cache = { key, data, window: target, fetchedAt, staleAt: staleAt(fetchedAt, ctx) }
        paint(data, ctx)
      } catch (err) {
        console.error(`[chartlayers] ${layer.id} fetch failed for pane ${pane.id}`, err)
      }
    }

    const scheduleRedraw = (): void => {
      if (!on || released) return
      const now = Date.now()
      if (timer === null) scheduledAt = now
      else clearTimeout(timer)
      // Trailing debounce, but never deferred past MAX_DEBOUNCE_MS from the first event of
      // the run: a live chart produces events faster than the debounce window forever, and a
      // purely trailing one would then never fire at all.
      const wait = Math.max(0, Math.min(layer.debounceMs ?? DEFAULT_DEBOUNCE_MS, scheduledAt + MAX_DEBOUNCE_MS - now))
      timer = setTimeout(() => {
        timer = null
        void redraw()
      }, wait)
    }

    const turnOff = (): void => {
      on = false
      if (timer) clearTimeout(timer)
      timer = null
      // Dropped rather than kept for a re-show: a pane that put the indicator away may be one
      // of a dozen, and what it held can be most of a book.
      owned.cache = null
      generation++
      clearOverlays()
    }

    // Two things raise nothing a subscription could hear. The legend's eye hides and shows the
    // indicator as klinecharts' own business. And rescaling the PRICE axis: klinecharts'
    // ActionType has no y-axis member, and the drag calls YAxis.setRange directly, so sampling
    // the band is the only way to notice that the view now reaches prices the pane never
    // fetched. A sample where neither moved costs two cheap calls and schedules nothing; a
    // moved band usually resolves to a repaint from what the pane already holds, and only
    // reaches the network when it grew past it.
    const sample = (): void => {
      if (released) return
      const now = shown()
      const band = now ? visiblePriceBand(chart) : null
      const signature = band ? `${band.low}|${band.high}` : ''
      if (now !== on) {
        if (!now) {
          turnOff()
          return
        }
        // Drawn at once rather than debounced: this is the user's own click, or a binding just
        // made. The band is taken now so the next sample does not schedule a second fetch
        // while this one is still in flight.
        on = true
        axisSignature = signature
        void redraw()
        return
      }
      if (!on || signature === axisSignature) return
      axisSignature = signature
      scheduleRedraw()
    }

    // Pan, zoom and every data load land here -- not a tick that only moves the forming bar,
    // which changes nothing a layer draws from but the price band, and that is sampled. The
    // price axis has no event at all -- see sample.
    const unwatchView = onViewMoved(chart, scheduleRedraw)
    const poll = setInterval(sample, POLL_MS)
    const view = {
      invalidate: (): void => {
        owned.cache = null
        void redraw()
      }
    }
    views.add(view)
    sample()

    return () => {
      released = true
      generation++
      if (timer) clearTimeout(timer)
      timer = null
      clearInterval(poll)
      views.delete(view)
      unwatchView()
      // Replaced by the binding that followed it: the successor holds the pane now. Released
      // with no successor, the indicator came off the pane (or the pane went): what it drew
      // goes with it, and what it held is dropped rather than kept for a re-add.
      if (owned.owner !== self) return
      owned.owner = null
      owned.cache = null
      clearOverlays()
      holds.delete(chart)
    }
  }

  return {
    layer: layer as ChartLayer<unknown, TConfig>,
    template,
    codec,
    baseline: () => baseline,
    ready,
    attach,
    invalidate(): void {
      for (const view of views) view.invalidate()
    }
  }
}
