import type { IndicatorGroup } from '../../src'
import { peekStore } from '../plugins/store'
import { GRID_ARRAY, type RegistryStore, storeFactory } from '../tsregistry/store'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, Range, SettingsRequest, SourceSpec } from '../plugins/types'
import { type ArevPoint, fetchMtfBarGrid, type MtfInterval } from './api'
import { MTF_DEFAULTS, MTF_FIELDS, MTF_GRAPH_FIELDS, enabledIntervals, graphConfig, graphRoots, type MtfConfig } from './config'
import { graphStart, rootLookbackMs, storeGraphSignals } from './graph'
import { fromAbsolute, isFinerThan, toAbsolute } from './shift'
import { AREV21_MTF, type MtfOverlay } from './overlays'
import { registerMtfIndicators } from './templates'

// A multi-timeframe signal overlay as a client plugin -- AREV21 MTF, and the arev21_outlier
// rank overlays built on the same machinery (overlays.ts says what differs between them). Where the AREV plugin binds one
// source per pane, this binds N -- one per source timeframe the pane's settings switch on
// -- and each source fetches a BAR GRID as well as the votes, because placing a vote one
// source bar forward is a question about that timeframe's candle boundaries (shift.ts).
//
// Settings are per pane and live in that pane's own entry of the wall document
// (client/layout.ts's PersistedPane.mtf), keyed by pane index. The plugin is their only
// writer: it is seeded with what the layout hydrated (`paneState.hydrate`), and asks the
// app to save the wall whenever the panel edits one. A settings edit bumps the pane's
// config revision, which is part of the binding signature, so the host rebinds: sources
// newly switched on are fetched, and the template repaints off the config in extendData.
//
// Like AREV there is nothing to subscribe: the rows are written by hand-run research
// scripts, not a live feed.

// A fetch is widened past the chart's own span at both ends, and neither end is optional.
// FORWARD, because the newest vote in the window can only be placed once its successor bar
// is known, and that bar lies beyond the window by definition. BACKWARD, because a vote
// cast just before the window shifts INTO it. The floor covers the market's longest routine
// gap -- an FX weekend is ~65h, and a holiday can stretch it -- so a Friday vote's successor
// is always in reach.
const WINDOW_PAD_BARS = 4
const WINDOW_PAD_FLOOR_MS = 7 * 86_400_000

// With the signal graphs on, every timeframe below a root is fetched back to the start of that
// root's graph in force at the chart's loaded left edge (graph.ts `graphStart`), because what a
// node hangs from can lie anywhere between there and the node. Bounded, so a 1D root's months-long
// graph cannot pull months of 3m votes: past this many of its own bars a timeframe's oldest
// nodes are missing, which changes only where a node of a still-shorter timeframe hangs from.
const GRAPH_LOOKBACK_MAX_BARS = 10_000

// `/getbars` is bounded by range, not by count, and 413s past the server's per-request bar
// cap. A gap is therefore fetched in chunks of at most this many NOMINAL source bars --
// nominal overcounts (the market is shut about a third of the week), so the real reply is
// always comfortably under the 5000 cap.
const GRID_CHUNK_BARS = 4000

/** Rough height of one klinecharts legend row, used only to hang the settings panel just
 * below the legend the gear sits in. */
const LEGEND_ROW_HEIGHT = 24

export function createMtfPlugin(overlay: MtfOverlay = AREV21_MTF): IndicatorPlugin {
  const title = overlay.title
  let facilities: PluginFacilities | null = null
  /** Every pane's settings by pane index -- the accumulated set: seeded from the document
   * and updated on every edit, so it survives a pane being unwired. */
  const configs: Record<number, MtfConfig> = {}
  const configRevs: Record<number, number> = {}
  let panel: { close(): void } | null = null

  const configFor = (paneIndex: number): MtfConfig => configs[paneIndex] ?? MTF_DEFAULTS

  /** A source timeframe finer than the chart's is refused rather than drawn: hundreds of
   * sub-bar votes collapsing onto one candle reads as noise, not as context. Named in the
   * legend, because silently drawing nothing is indistinguishable from a timeframe no run
   * has ever written. */
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

  // The series' key plus `|mtf`: the overlay's OWN store, never the registry sub-pane's.
  // A store keeps one record of which ranges have been fetched, and a sub-pane fetches no
  // bar grid -- so sharing its store meant a window the sub-pane loaded first counted as
  // covered, the overlay never fetched that window's grid, and every vote in it was dropped
  // as not yet closed (a 1h chart drew only the 8h lane: the one timeframe no pane on the
  // wall had a sub-pane at). The price is fetching the votes twice when both are on a wall.
  const storeKey = (ctx: BindContext, interval: MtfInterval): string =>
    `${overlay.sourceKey(ctx.vendor, ctx.ticker, interval)}|mtf`

  const source = (
    f: PluginFacilities,
    ctx: BindContext,
    interval: MtfInterval,
    roots: readonly MtfInterval[]
  ): SourceSpec<ArevPoint> => {
    const vendorSymbol = `${ctx.vendor}:${ctx.ticker}`
    const durationMs = f.resolutionDurationMs(interval)
    const chunk = GRID_CHUNK_BARS * durationMs
    // How much further back than the chart the graphs need this timeframe, from the chart's
    // loaded left edge (absolute) -- 0 when it takes part in no graph.
    //
    // A root looks back a fixed number of its own bars, to find the run of same-side root
    // signals in force at the left edge. Every timeframe under a root then reaches back to where
    // that run began, which it reads off the root's store -- the furthest any root above it
    // asks, since one timeframe serves every graph it is a node of (an 8h source is the 8h
    // graphs' root AND a node of the 1D graph). The host covers a binding's sources in order and
    // awaits each, and they are listed longest first when graphs are on (`bind`), so every
    // root above a timeframe has been fetched by the time its window is sized.
    const graphReach = (loadedFrom: number): number => {
      let reach = roots.includes(interval) ? rootLookbackMs(interval) : 0
      for (const root of roots) {
        if (!(durationMs < f.resolutionDurationMs(root))) continue
        const rootStore = peekStore<RegistryStore<ArevPoint>>(storeKey(ctx, root))
        if (!rootStore) continue
        const start = graphStart(storeGraphSignals(root, rootStore), loadedFrom, rootLookbackMs(root))
        reach = Math.max(reach, Math.min(Math.max(0, loadedFrom - start), GRAPH_LOOKBACK_MAX_BARS * durationMs))
      }
      return reach
    }
    return {
      id: interval,
      key: storeKey(ctx, interval),
      // The SOURCE timeframe, not the chart's: this is what its points are dated on. The
      // AREV sub-pane's spec for this key says the same, so a replay step forgets one
      // amount rather than two (plugins/horizon.ts).
      resolution: interval,
      createStore: storeFactory(null),
      /** The chart's loaded span, converted out of the chart's wire clock and into the
       * source timeframe's, padded at both ends. Both conversions are needed and they
       * differ whenever exactly one of the two intervals is daily-or-coarser. */
      window: (chartRange: Range): Range => {
        const pad = Math.max(WINDOW_PAD_BARS * f.resolutionDurationMs(interval), WINDOW_PAD_FLOOR_MS)
        const loadedFrom = toAbsolute(ctx.interval, chartRange.from)
        const absFrom = loadedFrom - graphReach(loadedFrom) - pad
        const absTo = toAbsolute(ctx.interval, chartRange.to - 1) + pad
        return { from: fromAbsolute(interval, absFrom), to: fromAbsolute(interval, absTo) }
      },
      // Votes and grid together, over one chunk, so a single range covers both in the
      // store. Concurrently, because neither depends on the other.
      //
      // The votes are the page's POINTS -- the same `ArevPoint` the sub-pane on this key
      // stores -- and the grid rides beside them as an auxiliary array, which is what that
      // mechanism is for: a different kind of row on the same window, not more of the same
      // one. It therefore has no cursor of its own; `nextFrom` is driven by the chunk.
      fetch: async (range, limit) => {
        const to = Math.min(range.to, range.from + chunk)
        const [votes, grid] = await Promise.all([
          overlay.fetchPoints(f, vendorSymbol, interval, range.from, to, limit),
          fetchMtfBarGrid(vendorSymbol, interval, range.from, to)
        ])
        // A vote page capped short of the chunk resumes where it stopped; the grid for the
        // rest of the chunk is fetched again then, which the store's grid set absorbs.
        const capped = votes.nextFrom !== null && votes.nextFrom < to ? votes.nextFrom : null
        return {
          points: votes.points,
          nextFrom: capped ?? (to < range.to ? to : null),
          arrays: { [GRID_ARRAY]: grid }
        }
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
    const stores = shown.map((interval) => state.sources.find((s) => s.id === interval)?.store)
    if (stores.some((s) => s?.phase === 'error')) return `${title} · error`
    if (stores.some((s) => !s || s.phase === 'idle' || s.phase === 'loading')) {
      return `${title} ${shown.join(' ')} · loading`
    }
    // Names the active set, which is the one thing eight separate legend rows used to say
    // for free.
    return `${title} ${shown.join(' ')}${graphLabel(config, state.chartInterval)}`
  }

  const openPanel = (paneId: string): boolean => {
    const f = facilities
    const info = f?.paneInfo(paneId)
    if (!f || !info) return false
    // The gear is drawn on the chart's CANVAS, not in the DOM, so there is no element to
    // point at. The chart container is what the panel must live inside (it is what carries
    // the theme class the panel's tokens resolve against), but it is the full height of the
    // pane, so its own rect is the wrong place to hang the panel from -- under its bottom
    // edge is below the fold. Hence an explicit rect: the panel opens just under the
    // legend row at the chart's top left, which is where the gear that opened it is drawn.
    let anchor: HTMLElement | null = null
    try {
      anchor = info.chart.getDom() as HTMLElement | null
    } catch {
      anchor = null
    }
    if (!anchor) return false
    const chartRect = anchor.getBoundingClientRect()
    const paneIndex = info.paneIndex
    panel?.close()
    panel = f.openSettingsPanel<MtfConfig>({
      anchor,
      anchorRect: { top: chartRect.top, bottom: chartRect.top + LEGEND_ROW_HEIGHT, left: chartRect.left + 8 },
      // Names the pane, because the settings are that pane's alone and a wall can have
      // twelve of them open on different instruments.
      title: `${title} · ${info.pane.getSymbol().ticker} ${f.periodToResolution(info.pane.getPeriod())}`,
      // No enable row: this overlay's on/off is the indicator being on the pane at all,
      // which the picker and the legend's own close icon already own.
      fields: overlay.graph ? [...MTF_GRAPH_FIELDS, ...MTF_FIELDS] : MTF_FIELDS,
      config: configFor(paneIndex),
      defaults: MTF_DEFAULTS,
      onChange: (next) => {
        configs[paneIndex] = next
        configRevs[paneIndex] = (configRevs[paneIndex] ?? 0) + 1
        f.requestPersist()
        // Only this pane: the settings belong to it, so another pane showing the same
        // instrument keeps whatever it was set to.
        f.requestReconcile(paneId)
      },
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  return {
    id: overlay.id,
    feature: overlay.feature,
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerMtfIndicators(overlay)
    },
    matches: (name) => name === overlay.templateName,
    signature: (ctx) => [configRevs[ctx.paneIndex] ?? 0, enabledIntervals(configFor(ctx.paneIndex))],
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const config = configFor(ctx.paneIndex)
      const shown = drawable(config, ctx.interval)
      const roots = graphRootsFor(config, ctx.interval)
      // Longest first when graphs are on: a timeframe's window is sized from the stores of
      // the roots above it.
      const ordered =
        roots.length > 0 ? [...shown].sort((a, b) => f.resolutionDurationMs(b) - f.resolutionDurationMs(a)) : shown
      return {
        // Stores are created only for timeframes switched on: switching all eight on and
        // off again should not leave eight populated caches behind.
        sources: ordered.map((interval) => source(f, ctx, interval, roots)),
        label: (state) => label(config, state),
        extendData: () => ({
          chartInterval: ctx.interval,
          config,
          graphRoots: roots,
          symbol: `${ctx.vendor}:${ctx.ticker}`
        })
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      if (request.indicatorName !== overlay.templateName) return false
      return openPanel(request.paneId)
    },
    ownsSettings: (templateName) => templateName === overlay.templateName,
    paneState: {
      hydrate(initial) {
        for (const [index, config] of Object.entries(initial)) {
          if (config) configs[Number(index)] = structuredClone(config as MtfConfig)
        }
      },
      snapshot: () => ({ ...configs })
    },
    dispose() {
      panel?.close()
      panel = null
    }
  }
}
