import type { IndicatorGroup } from '../../src'
import { getReadClock } from '../config'
import { type PaneConfig, paneConfig } from '../plugins/paneconfig'
import { LIVE_LOADERS, type LiveLoaders, type LiveWire, liveWire } from '../tsregistry/plugin'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  IndicatorPlugin,
  PluginFacilities,
  Range,
  SourceNotify,
  SourceSpec,
  SourceStore
} from '../plugins/types'
import type { PluginPointListener } from '../stream'
import { fetchMtfGraph, type MtfInterval, type MtfSignalRow, warmMtfGraph } from './api'
import {
  MTF_DEFAULTS,
  MTF_FIELDS,
  MTF_GRAPH_FIELDS,
  enabledIntervals,
  fromStoredMtfConfig,
  graphConfig,
  graphRoots,
  type MtfConfig,
  toStoredMtfConfig
} from './config'
import { type CandleGrid, gridFor } from '../replay/timeframes'
import { isFinerThan, toAbsolute } from './shift'
import { AREV21_MTF, type MtfOverlay } from './overlays'
import { phaseLabel } from '../plugins/legend'
import { registerMtfIndicators } from './templates'
import { createMtfGraphStore, type MtfGraphStore, NODES_ARRAY } from './store'

// A multi-timeframe signal overlay as a client plugin -- AREV21 MTF, and the arev21_outlier
// rank overlays (overlays.ts says what differs between them). Each binding reads ONE source: the
// server's answer for the pane's instrument and settings (`GET /mtf/graph`) -- every signal on
// the timeframes the pane draws, each at the instant it became knowable, and, where the overlay
// offers it, the signal graph between them with its entry stars. The server builds and caches
// all of it (wdashboard-server services/mtfgraph.py, 0.56.0); the template places it on the
// chart's own bars and draws it.
//
// Until then each binding bound one source per timeframe, fetched every timeframe's votes and
// its bar grid, sized each window from the graph roots' stores, and built the graph in `calc`.
//
// Settings are per pane (`mtfPaneConfig`), kept by the host and stored in that pane's own entry
// of the wall document: `PersistedPane.mtf` for AREV21 MTF, `PersistedPane.mx[<id>]` for the
// others. An edit rebinds, and the settings that decide the data -- the timeframes drawn, the
// roots, the largest step -- are the source's key, so a different combination is a different
// store and the same one shared.
//
// LIVE, one subscription per timeframe drawn: the research feed writes arev21 as each bar closes
// and the server relays it (`plugins.live`); a relayed point on a timeframe makes the binding
// re-read everything knowable from that bar's close on, which is all a new bar can change. A
// pushed point is never filed: it carries none of what the overlay draws.
//
// IN A BAR REPLAY, where the next Next alert press will land is known before the press
// (client/replay/alerts.ts), and the first read of a region of history is the server's expensive
// one. So each source offers `warm`: the window the pane will read there, under the clock the
// landing sets, sent ahead (`PluginHost.warmAhead`) for the server to build and keep, and the
// answer thrown away -- the press's own read is then a slice of what the server holds.

/** The source's id in `extendData.seriesKeys`. */
export const GRAPH_SOURCE = 'graph'

/** How far before the chart's first bar a read starts: a signal that became knowable inside
 * the market-closed gap before it is drawn ON that bar, and the longest routine gap is an FX
 * weekend (~65 h; a holiday can stretch it). */
const WINDOW_BACK_PAD_MS = 4 * 86_400_000

/** One overlay's per-pane settings: which timeframes it draws and each one's colour and sizes,
 * and the graph's where it offers one. A diff from the defaults in the wall document, under the
 * pane's `mtf` for the original overlay -- its field since before there were others -- and under
 * `mx` by plugin id for the rest. The codec is hand-written (config.ts): it reads the single
 * graph root an older build stored, and its colour checks are not the fields'. */
export function mtfPaneConfig(overlay: MtfOverlay): PaneConfig {
  return paneConfig<MtfConfig>({
    templates: [overlay.templateName],
    doc: overlay.id === AREV21_MTF.id ? 'mtf' : ['mx', overlay.id],
    title: overlay.title,
    // Only an overlay that offers a graph shows the graph's settings.
    fields: overlay.graph ? [...MTF_GRAPH_FIELDS, ...MTF_FIELDS] : MTF_FIELDS,
    defaults: MTF_DEFAULTS,
    normalise: (config) => structuredClone(config),
    toStored: toStoredMtfConfig,
    fromStored: fromStoredMtfConfig
  })
}

/** The wire that tells the overlay one of its timeframes has a new bar: its `liveEntry`'s,
 * ALWAYS as a cue to re-read (`direct: false`), never as a value to file. Null where nothing
 * pushes (no `plugins.live`, or a server whose arev wire is not live), which leaves the overlay
 * as it was: new signals on a reload or a range change. */
export async function mtfLiveWire(
  f: Pick<PluginFacilities, 'hasFeature'>,
  overlay: MtfOverlay,
  load: LiveLoaders = LIVE_LOADERS
): Promise<LiveWire | null> {
  const entry = (await load.registry()).find((e) => e.name === overlay.liveEntry)
  const found = entry ? await liveWire(f, entry, load) : null
  return found && { ...found, direct: false }
}

/**
 * Whether what became knowable at the close of a pane's last bar (opening `lastOpen`, closing
 * `close`) is to be read: whether that instant has passed while the chart holds no bar for it.
 *
 * - In a replay, once the read clock has reached it: a replay standing on a bar's close (Next
 *   alert stops on the close of the bar whose star it found) knows what became knowable then,
 *   though the next bar has no prices yet.
 * - Live, once it has passed where the market then closes -- Friday's 17:00 on the FX week, an
 *   equity session's 16:00 -- so no bar opens until the market does. Until 2026-10-28 every
 *   signal knowable at Friday's close (the 1D, 8h, 4h and every intraday one closing then) was
 *   on no intraday chart all weekend. Not at any other close: the last bar is then forming, and
 *   the next one opens at its close and carries what became knowable there; reading the
 *   instant before it opens would file it as read before the research feed has written it.
 *   (Around Friday's close that risk remains, healed by the overlay's live cue, which re-reads
 *   from the bar's close once its signal is written: `graphSubscribe`.)
 *
 * The browser's clock decides "passed" live; it only matters within its error of the close.
 * `readClock` is the page-wide one unless a caller asks about another: the clock a replay will
 * stand at once its next press lands (`warm`).
 */
export function closeKnown(
  clock: CandleGrid,
  interval: string,
  lastOpen: number,
  close: number,
  now: number = Date.now(),
  readClock: number | null = getReadClock()
): boolean {
  if (readClock !== null) return close <= readClock
  return close <= now && clock.nextStart(interval, lastOpen) > close
}

/** The store identity: everything that decides the answer, and nothing else. */
export function graphSourceKey(
  overlay: MtfOverlay,
  symbol: string,
  timeframes: readonly string[],
  roots: readonly string[],
  maxStep: number
): string {
  return `mtf|${overlay.source}|${JSON.stringify(overlay.params ?? {})}|${symbol}|${timeframes.join(',')}|${roots.join(',')}|${maxStep}`
}

/**
 * The live half: one subscription per timeframe drawn. A point on a timeframe is that bar's
 * close, and everything knowable from then on may have changed -- a new signal, a node that now
 * joins, a graph a new root signal ends -- so the store forgets from there and the host reads it
 * again. Each subscription's ack does the same from the newest row held, because a point sent
 * while the socket was down is not replayed.
 */
export function graphSubscribe(
  f: PluginFacilities,
  ctx: Pick<BindContext, 'vendor' | 'ticker'>,
  overlay: MtfOverlay,
  intervals: readonly string[],
  clock: CandleGrid,
  load: LiveLoaders = LIVE_LOADERS
) {
  return (store: SourceStore<MtfSignalRow>, notify: SourceNotify): (() => void) => {
    const s = store as MtfGraphStore
    let disposed = false
    const offs: Array<() => void> = []
    const rereadFrom = (from: number | null) => {
      const latest = s.latest()
      if (latest === null && from === null) return
      const start = latest === null ? (from as number) : from === null ? latest + 1 : Math.min(from, latest + 1)
      s.forgetAfter(start)
      notify.refetch()
    }
    mtfLiveWire(f, overlay, load)
      .then((found) => {
        if (disposed || found === null) return
        const variant = found.wire.variant ?? null
        for (const interval of intervals) {
          const listener: PluginPointListener = {
            onPoint: (point) => rereadFrom(clock.end(interval, clock.fromWire(interval, point.date))),
            onSubscribed: () => rereadFrom(null)
          }
          f.stream.subscribePlugin(found.wire.plugin, variant, ctx.vendor, ctx.ticker, interval, listener)
          offs.push(() => f.stream.unsubscribePlugin(found.wire.plugin, variant, ctx.vendor, ctx.ticker, interval, listener))
        }
      })
      .catch((err) => console.warn(`[mtf] no live signals for ${overlay.title}`, err))
    return () => {
      disposed = true
      for (const off of offs) off()
    }
  }
}

export function createMtfPlugin(overlay: MtfOverlay = AREV21_MTF, load: LiveLoaders = LIVE_LOADERS): IndicatorPlugin {
  const title = overlay.title
  let facilities: PluginFacilities | null = null

  /** A timeframe finer than the chart's is refused rather than drawn: hundreds of sub-bar
   * signals collapsing onto one candle reads as noise, not as context. Named in the legend,
   * because silently drawing nothing is indistinguishable from a timeframe no run has written. */
  const drawable = (config: MtfConfig, chartInterval: string): MtfInterval[] =>
    enabledIntervals(config).filter((interval) => !isFinerThan(interval, chartInterval))

  /** The roots this pane's graphs start from, longest first: none when the overlay offers no
   * graph or none is switched on, and only the ones among the timeframes drawn. The graphs are
   * made of drawn signals only -- a node with no marker would be a line to nothing. */
  const graphRootsFor = (config: MtfConfig, chartInterval: string): MtfInterval[] => {
    if (!overlay.graph) return []
    const shown = drawable(config, chartInterval)
    return graphRoots(config).filter((root) => shown.includes(root))
  }

  const source = (
    f: PluginFacilities,
    ctx: BindContext,
    shown: readonly MtfInterval[],
    roots: readonly MtfInterval[],
    maxStep: number,
    clock: CandleGrid
  ): SourceSpec<MtfSignalRow> => {
    const symbol = `${ctx.vendor}:${ctx.ticker}`
    const request = { symbol, source: overlay.source, params: overlay.params, timeframes: shown, roots, maxStep }
    /** The chart's loaded bars as instants: from the first one's open (less the gap before it) to
     * the last one's close -- and that close itself once the read clock has reached it and no bar
     * opens at it to carry what became knowable then, which the chart draws in the slot the next
     * bar will take (shift.ts `chartBarAt`). */
    const windowAt = (chartRange: Range, readClock: number | null): Range => {
      const lastOpen = toAbsolute(ctx.interval, chartRange.to - 1, clock)
      const close = clock.end(ctx.interval, lastOpen)
      return {
        from: toAbsolute(ctx.interval, chartRange.from, clock) - WINDOW_BACK_PAD_MS,
        to: closeKnown(clock, ctx.interval, lastOpen, close, Date.now(), readClock) ? close + 1 : close
      }
    }
    return {
      id: GRAPH_SOURCE,
      key: graphSourceKey(overlay, symbol, shown, roots, maxStep),
      // No `resolution`: the rows are instants, not bars of one interval, and the store's windows
      // are absolute -- so a replay step forgets from the cursor itself (plugins/horizon.ts),
      // which is exactly when each row came to exist.
      createStore: createMtfGraphStore,
      window: (chartRange: Range): Range => windowAt(chartRange, getReadClock()),
      fetch: async (range, limit) => {
        const answer = await fetchMtfGraph({ ...request, from: range.from, to: range.to, limit })
        return { points: answer.signals, nextFrom: answer.nextFrom, arrays: { [NODES_ARRAY]: answer.nodes } }
      },
      subscribe: graphSubscribe(f, ctx, overlay, shown, clock, load),
      // A bar replay's next landing, read by the server before the press (wdashboard-server
      // services/mtfgraph.py): the window this pane will ask for there, under the clock the
      // landing sets -- which the server's cache answers as a slice of what this read built.
      warm: {
        window: (chartRange: Range, at: number): Range => windowAt(chartRange, at),
        read: (range: Range, at: number) => warmMtfGraph({ ...request, from: range.from, to: range.to, asof: at })
      }
    }
  }

  /** What the legend says about the graphs: nothing when the overlay offers none or no root
   * is on, which roots they start from, and why any root switched on cannot draw here. */
  const graphLabel = (config: MtfConfig, chartInterval: string): string => {
    if (!overlay.graph) return ''
    const drawn = graphRootsFor(config, chartInterval)
    const only = graphConfig(config).onlyGraph && drawn.length > 0 ? ', rest hidden' : ''
    const parts = drawn.length > 0 ? [`graph from ${drawn.join(' ')}${only}`] : []
    // Named rather than silently skipped, like a timeframe the chart is too coarse for.
    for (const root of graphRoots(config)) {
      if (drawn.includes(root)) continue
      parts.push(isFinerThan(root, chartInterval) ? `graph ${root} needs ≤ ${root} chart` : `graph ${root} needs ${root} on`)
    }
    return parts.map((part) => ` · ${part}`).join('')
  }

  const label = (config: MtfConfig, state: BindingState): string => {
    const shown = drawable(config, state.chartInterval)
    if (shown.length === 0) {
      const on = enabledIntervals(config)
      return on.length === 0 ? `${title} · none on` : `${title} · needs ≥ ${state.chartInterval} chart`
    }
    const pending = phaseLabel(`${title} ${shown.join(' ')}`, [state.sources[0]?.store])
    if (pending) return pending
    // Names the active set, which is the one thing eight separate legend rows used to say
    // for free.
    return `${title} ${shown.join(' ')}${graphLabel(config, state.chartInterval)}`
  }

  return {
    id: overlay.id,
    // The server builds every overlay's data; the family's own feature is checked at register.
    feature: 'mtf_graph',
    paneConfigs: [mtfPaneConfig(overlay)],
    register(f: PluginFacilities): IndicatorGroup[] {
      if (!f.hasFeature(overlay.feature)) return []
      facilities = f
      return registerMtfIndicators(overlay)
    },
    matches: (name) => name === overlay.templateName,
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const config = ctx.config as MtfConfig
      // The pane's instrument's own candle grid: which chart bar was open when a signal became
      // knowable depends on how that market dates its days. With none resolved the overlay says
      // so and draws nothing, rather than place signals on the forex week's clock -- which put
      // coinbase's daily votes seven hours early.
      const clock = gridFor(ctx.symbol)
      if (!clock) {
        return {
          sources: [],
          label: () => `${title} · no market hours for this instrument`,
          extendData: () => ({ chartInterval: ctx.interval, config, graphRoots: [], intervals: [] })
        }
      }
      const shown = drawable(config, ctx.interval)
      const roots = graphRootsFor(config, ctx.interval)
      // The settings panel commits every keystroke, so a half-typed number reaches here; the
      // server holds a step to the same floor.
      const maxStep = Math.max(2, graphConfig(config).maxStep)
      return {
        sources: shown.length > 0 ? [source(f, ctx, shown, roots, maxStep, clock)] : [],
        label: (state) => label(config, state),
        extendData: () => ({
          chartInterval: ctx.interval,
          // The schedule as plain data: the template rebuilds the grid from it, and extendData
          // is compared and may be copied, which a bag of closures does not survive.
          schedule: clock.schedule,
          config,
          graphRoots: roots,
          intervals: shown
        })
      }
    }
  }
}
