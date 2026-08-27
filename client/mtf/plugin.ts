import type { IndicatorGroup } from '../../src'
import { arevSourceKey } from '../arev/plugin'
import { GRID_ARRAY, arevStore } from '../arev/store'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, Range, SettingsRequest, SourceSpec } from '../plugins/types'
import { MTF_GENERATION, type ArevPoint, fetchMtfBarGrid, fetchMtfPoints, type MtfInterval } from './api'
import { MTF_DEFAULTS, MTF_FIELDS, enabledIntervals, type MtfConfig } from './config'
import { fromAbsolute, isFinerThan, toAbsolute } from './shift'
import { TEMPLATE_NAME, isMtfIndicator, registerMtfIndicators } from './templates'

// The AREV21 multi-timeframe overlay as a client plugin. Where the AREV plugin binds one
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

// `/getbars` is bounded by range, not by count, and 413s past the server's per-request bar
// cap. A gap is therefore fetched in chunks of at most this many NOMINAL source bars --
// nominal overcounts (the market is shut about a third of the week), so the real reply is
// always comfortably under the 5000 cap.
const GRID_CHUNK_BARS = 4000

/** Rough height of one klinecharts legend row, used only to hang the settings panel just
 * below the legend the gear sits in. */
const LEGEND_ROW_HEIGHT = 24

export function createMtfPlugin(): IndicatorPlugin {
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

  const source = (f: PluginFacilities, ctx: BindContext, interval: MtfInterval): SourceSpec<ArevPoint> => {
    const vendorSymbol = `${ctx.vendor}:${ctx.ticker}`
    const chunk = GRID_CHUNK_BARS * f.resolutionDurationMs(interval)
    return {
      id: interval,
      // The same key the AREV plugin would give arev21 at this interval: a sub-pane and
      // the overlay reading the same votes share one store. Sharing a key means sharing
      // the row type and the factory as well -- see arev/store.ts for what went wrong when
      // these two wrote different things under it.
      key: arevSourceKey(MTF_GENERATION, ctx.vendor, ctx.ticker, interval),
      // The SOURCE timeframe, not the chart's: this is what its points are dated on. The
      // AREV sub-pane's spec for this key says the same, so a replay step forgets one
      // amount rather than two (plugins/horizon.ts).
      resolution: interval,
      createStore: arevStore,
      /** The chart's loaded span, converted out of the chart's wire clock and into the
       * source timeframe's, padded at both ends. Both conversions are needed and they
       * differ whenever exactly one of the two intervals is daily-or-coarser. */
      window: (chartRange: Range): Range => {
        const pad = Math.max(WINDOW_PAD_BARS * f.resolutionDurationMs(interval), WINDOW_PAD_FLOOR_MS)
        const absFrom = toAbsolute(ctx.interval, chartRange.from) - pad
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
        const [points, grid] = await Promise.all([
          fetchMtfPoints(vendorSymbol, interval, range.from, to, limit),
          fetchMtfBarGrid(vendorSymbol, interval, range.from, to)
        ])
        return {
          points,
          nextFrom: to < range.to ? to : null,
          arrays: { [GRID_ARRAY]: grid.map((date) => ({ date })) }
        }
      }
    }
  }

  const label = (config: MtfConfig, state: BindingState): string => {
    const shown = drawable(config, state.chartInterval)
    if (shown.length === 0) {
      const on = enabledIntervals(config)
      return on.length === 0 ? 'AREV21 MTF · none on' : `AREV21 MTF · needs ≥ ${state.chartInterval} chart`
    }
    const stores = shown.map((interval) => state.sources.find((s) => s.id === interval)?.store)
    if (stores.some((s) => s?.phase === 'error')) return 'AREV21 MTF · error'
    if (stores.some((s) => !s || s.phase === 'idle' || s.phase === 'loading')) {
      return `AREV21 MTF ${shown.join(' ')} · loading`
    }
    // Names the active set, which is the one thing eight separate legend rows used to say
    // for free.
    return `AREV21 MTF ${shown.join(' ')}`
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
      title: `AREV21 MTF · ${info.pane.getSymbol().ticker} ${f.periodToResolution(info.pane.getPeriod())}`,
      // No enable row: this overlay's on/off is the indicator being on the pane at all,
      // which the picker and the legend's own close icon already own.
      fields: MTF_FIELDS,
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
    id: 'mtf',
    // Reads the same `/arev/values` the AREV panes do, which is why it gates on 'arev'
    // and not on a capability of its own -- there is no new server surface behind it.
    feature: 'arev',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerMtfIndicators()
    },
    matches: isMtfIndicator,
    signature: (ctx) => [configRevs[ctx.paneIndex] ?? 0, enabledIntervals(configFor(ctx.paneIndex))],
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const config = configFor(ctx.paneIndex)
      const shown = drawable(config, ctx.interval)
      return {
        // Stores are created only for timeframes switched on: switching all eight on and
        // off again should not leave eight populated caches behind.
        sources: shown.map((interval) => source(f, ctx, interval)),
        label: (state) => label(config, state),
        extendData: () => ({ chartInterval: ctx.interval, config })
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      if (request.indicatorName !== TEMPLATE_NAME) return false
      return openPanel(request.paneId)
    },
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
