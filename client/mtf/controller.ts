import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { openSettingsPanel, type SettingsPanelHandle } from '../chartlayers/settings'
import { periodToResolution, resolutionDurationMs } from '../periods'
import { symbolVendor } from '../symbols'
import { MTF_GENERATION, fetchMtfBarGrid, fetchMtfPoints, type MtfInterval } from './api'
import {
  MTF_DEFAULTS,
  MTF_FIELDS,
  enabledIntervals,
  loadMtfConfig,
  saveMtfConfig,
  type MtfConfig
} from './config'
import { fromAbsolute, isFinerThan, toAbsolute } from './shift'
import { dropStore, storeFor, type MtfStore, type Range } from './store'
import { TEMPLATE_NAME, isMtfIndicator, type ExtendData } from './templates'

// Keeps the one AREV21 multi-timeframe overlay fed on every pane that has it, and owns its
// settings panel.
//
// Where the AREV controller has one binding per pane per generation, this has one binding
// per pane holding N source-timeframe stores — one for each timeframe the settings switch
// on. That is the shape the consolidation forced: a single indicator reads several series
// at once, so coverage, revision tracking and the legend all aggregate across them.
//
// It fetches a BAR GRID as well as the votes for each timeframe, because placing a vote one
// source bar forward is a question about that timeframe's candle boundaries (shift.ts).
//
// Like AREV there is nothing to subscribe: the rows are written by hand-run research
// scripts, not a live feed, so new votes appear when a script is re-run and a reload or a
// range change picks them up.

const POLL_MS = 500
const RANGE_DEBOUNCE_MS = 250
const MAX_VALUES_PER_REQUEST = 5000

// A fetch is widened past the chart's own span at both ends, and neither end is optional.
// FORWARD, because the newest vote in the window can only be placed once its successor bar
// is known, and that bar lies beyond the window by definition. BACKWARD, because a vote
// cast just before the window shifts INTO it. The floor covers the market's longest routine
// gap — an FX weekend is ~65h, and a holiday can stretch it — so a Friday vote's successor
// is always in reach.
const WINDOW_PAD_BARS = 4
const WINDOW_PAD_FLOOR_MS = 7 * 86_400_000

// `/getbars` is bounded by range, not by count, and 413s past the server's per-request bar
// cap. A gap is therefore fetched in chunks of at most this many NOMINAL source bars —
// nominal overcounts (the market is shut about a third of the week), so the real reply is
// always comfortably under the 5000 cap.
const GRID_CHUNK_BARS = 4000

/** Rough height of one klinecharts legend row, used only to hang the settings panel just
 * below the legend the gear sits in. */
const LEGEND_ROW_HEIGHT = 24

interface Binding {
  indicatorId: string
  chartPaneId: string
  vendor: string
  ticker: string
  chartInterval: string
  signature: string
  stores: Map<MtfInterval, MtfStore>
  inFlight: Set<string>
  disposed: boolean
  lastAppliedRev: number
  lastShortName: string
  lastConfigRev: number
}

interface WiredPane {
  pane: ChartProPane
  chart: Chart
  bindings: Map<string, Binding>
  poll: ReturnType<typeof setInterval>
  rangeTimer: ReturnType<typeof setTimeout> | null
  onRange: () => void
}

export interface MtfController {
  sync(panes: ChartProPane[]): void
  /** Wired as ChartProOptions.indicatorSettingsHandler: claims the gear on this indicator
   * and opens the per-timeframe panel instead of the numeric params dialog. */
  handleSettings(request: { indicatorName: string; paneId: string; chartPaneId: string }): boolean
}

export function createMtfController(): MtfController {
  const wired = new Map<string, WiredPane>()
  // Settings are per USER, not per pane: a colour that meant 4h on one pane and 1D on
  // another would defeat the point of colouring by timeframe at all. One config, shared by
  // every binding, loaded once and saved on every edit.
  let config: MtfConfig = MTF_DEFAULTS
  // Bumped on every settings edit so `apply` can tell "the stores changed" from "the way
  // they are drawn changed" — both must reach the template, only one needs a fetch.
  let configRev = 0
  let panel: SettingsPanelHandle | null = null

  void loadMtfConfig()
    .then((loaded) => {
      config = loaded
      configRev++
      // Whatever is already mounted was built against the defaults; re-apply so a saved
      // config takes effect without waiting for a pan.
      for (const entry of wired.values()) {
        for (const b of entry.bindings.values()) {
          apply(entry, b)
          void ensureCoverage(entry, b)
        }
      }
    })
    .catch((err) => console.warn('[mtf] settings load failed, using defaults', err))

  /** A source timeframe finer than the chart's is refused rather than drawn: hundreds of
   * sub-bar votes collapsing onto one candle reads as noise, not as context. Named in the
   * legend, because silently drawing nothing is indistinguishable from a timeframe no run
   * has ever written. */
  const drawable = (b: Binding): MtfInterval[] =>
    enabledIntervals(config).filter((interval) => !isFinerThan(interval, b.chartInterval))

  const label = (b: Binding): string => {
    const shown = drawable(b)
    if (shown.length === 0) {
      const on = enabledIntervals(config)
      return on.length === 0 ? 'AREV21 MTF · none on' : `AREV21 MTF · needs ≥ ${b.chartInterval} chart`
    }
    const stores = shown.map((interval) => b.stores.get(interval))
    if (stores.some((s) => s?.phase === 'error')) return `AREV21 MTF · error`
    if (stores.some((s) => !s || s.phase === 'idle' || s.phase === 'loading')) {
      return `AREV21 MTF ${shown.join(' ')} · loading`
    }
    // Names the active set, which is the one thing eight separate legend rows used to say
    // for free.
    return `AREV21 MTF ${shown.join(' ')}`
  }

  const storeKeyFor = (b: Binding, interval: MtfInterval): string =>
    `${MTF_GENERATION}|${b.vendor}:${b.ticker}|${interval}`

  /** Sum of every contributing store's revision, so any one of them changing moves it. */
  const aggregateRev = (b: Binding): number => {
    let rev = 0
    for (const interval of drawable(b)) rev += b.stores.get(interval)?.rev ?? 0
    return rev
  }

  const apply = (entry: WiredPane, b: Binding): void => {
    if (b.disposed) return
    const rev = aggregateRev(b)
    const shortName = label(b)
    if (rev === b.lastAppliedRev && shortName === b.lastShortName && configRev === b.lastConfigRev) return
    b.lastAppliedRev = rev
    b.lastShortName = shortName
    b.lastConfigRev = configRev
    const seriesKeys: Record<string, string> = {}
    for (const interval of drawable(b)) seriesKeys[interval] = storeKeyFor(b, interval)
    const extendData: ExtendData = { seriesKeys, rev: rev + configRev, chartInterval: b.chartInterval, config }
    try {
      entry.chart.overrideIndicator({ id: b.indicatorId, name: TEMPLATE_NAME, paneId: b.chartPaneId, extendData, shortName } as never)
    } catch (err) {
      console.warn('[mtf] override failed', err)
    }
  }

  /** The chart's loaded span, converted out of the chart's wire clock and into the source
   * timeframe's, padded at both ends. Both conversions are needed and they differ whenever
   * exactly one of the two intervals is daily-or-coarser — see shift.ts. */
  const sourceWindow = (chart: Chart, b: Binding, interval: MtfInterval): Range | null => {
    const data = chart.getDataList()
    if (data.length === 0) return null
    const pad = Math.max(WINDOW_PAD_BARS * resolutionDurationMs(interval), WINDOW_PAD_FLOOR_MS)
    const absFrom = toAbsolute(b.chartInterval, data[0].timestamp) - pad
    const absTo = toAbsolute(b.chartInterval, data[data.length - 1].timestamp) + pad
    return { from: fromAbsolute(interval, absFrom), to: fromAbsolute(interval, absTo) }
  }

  const fetchGap = async (entry: WiredPane, b: Binding, interval: MtfInterval, gap: Range): Promise<void> => {
    const store = b.stores.get(interval)
    if (!store) return
    const tag = `${interval}|${gap.from}-${gap.to}`
    if (b.inFlight.has(tag)) return
    b.inFlight.add(tag)
    const vendorSymbol = `${b.vendor}:${b.ticker}`
    const chunk = GRID_CHUNK_BARS * resolutionDurationMs(interval)
    try {
      let from = gap.from
      let chunks = 0
      while (from < gap.to && !b.disposed && chunks < 20) {
        chunks++
        const to = Math.min(gap.to, from + chunk)
        // Votes and grid together, over one window, so a single range covers both in the
        // store. Concurrently, because neither depends on the other.
        const [points, grid] = await Promise.all([
          fetchMtfPoints(vendorSymbol, interval, from, to, MAX_VALUES_PER_REQUEST),
          fetchMtfBarGrid(vendorSymbol, interval, from, to)
        ])
        if (b.disposed) return
        store.setMany(points, grid, { from, to })
        store.setPhase('ready')
        apply(entry, b)
        from = to
      }
    } catch (err) {
      store.setPhase('error', err instanceof Error ? err.message : String(err))
      apply(entry, b)
      console.error(`[mtf] history fetch failed for ${interval}`, err)
    } finally {
      b.inFlight.delete(tag)
    }
  }

  const ensureCoverage = async (entry: WiredPane, b: Binding): Promise<void> => {
    if (b.disposed) return
    for (const interval of drawable(b)) {
      // Stores are created lazily, when a timeframe is first switched on: switching all
      // eight on and off again should not leave eight populated caches behind.
      let store = b.stores.get(interval)
      if (!store) {
        store = storeFor(storeKeyFor(b, interval))
        b.stores.set(interval, store)
      }
      const window = sourceWindow(entry.chart, b, interval)
      if (!window) continue
      for (const gap of store.missing(window)) await fetchGap(entry, b, interval, gap)
    }
    apply(entry, b)
  }

  const dispose = (b: Binding): void => {
    b.disposed = true
    // Drop each store when nobody else on the wall reads that exact source series.
    for (const [interval] of b.stores) {
      const key = storeKeyFor(b, interval)
      let used = false
      for (const e of wired.values()) {
        for (const other of e.bindings.values()) {
          if (other === b || other.disposed) continue
          if (other.stores.has(interval) && storeKeyFor(other, interval) === key) used = true
        }
      }
      if (!used) dropStore(key)
    }
    b.stores.clear()
  }

  const signatureOf = (chartPaneId: string, vendor: string, ticker: string, chartInterval: string): string =>
    JSON.stringify([chartPaneId, vendor, ticker, chartInterval])

  const reconcile = (entry: WiredPane): void => {
    let indicators: Indicator[]
    try {
      indicators = entry.chart.getIndicators().filter((i) => isMtfIndicator(i.name))
    } catch {
      return
    }
    const symbol = entry.pane.getSymbol()
    const chartInterval = periodToResolution(entry.pane.getPeriod())
    const vendor = symbolVendor(symbol)
    const seen = new Set<string>()
    const fresh: Binding[] = []
    for (const ind of indicators) {
      seen.add(ind.id)
      const sig = signatureOf(ind.paneId, vendor, symbol.ticker, chartInterval)
      const existing = entry.bindings.get(ind.id)
      if (existing && existing.signature === sig) continue
      if (existing) {
        dispose(existing)
        entry.bindings.delete(ind.id)
      }
      const b: Binding = {
        indicatorId: ind.id,
        chartPaneId: ind.paneId,
        vendor,
        ticker: symbol.ticker,
        chartInterval,
        signature: sig,
        stores: new Map(),
        inFlight: new Set(),
        disposed: false,
        lastAppliedRev: -1,
        lastShortName: '',
        lastConfigRev: -1
      }
      entry.bindings.set(ind.id, b)
      fresh.push(b)
    }
    for (const [id, b] of entry.bindings) {
      if (!seen.has(id)) {
        dispose(b)
        entry.bindings.delete(id)
      }
    }
    for (const b of fresh) {
      apply(entry, b)
      void ensureCoverage(entry, b)
    }
  }

  const coverAll = (entry: WiredPane): void => {
    for (const b of entry.bindings.values()) void ensureCoverage(entry, b)
  }

  const wire = (pane: ChartProPane): void => {
    const chart = pane.getChart()
    const entry: WiredPane = {
      pane,
      chart,
      bindings: new Map(),
      poll: setInterval(() => reconcile(entry), POLL_MS),
      rangeTimer: null,
      onRange: () => {
        if (entry.rangeTimer) clearTimeout(entry.rangeTimer)
        entry.rangeTimer = setTimeout(() => {
          entry.rangeTimer = null
          coverAll(entry)
        }, RANGE_DEBOUNCE_MS)
      }
    }
    chart.subscribeAction('onVisibleRangeChange', entry.onRange)
    wired.set(pane.id, entry)
    reconcile(entry)
  }

  const unwire = (id: string): void => {
    const entry = wired.get(id)
    if (!entry) return
    clearInterval(entry.poll)
    if (entry.rangeTimer) clearTimeout(entry.rangeTimer)
    try {
      entry.chart.unsubscribeAction('onVisibleRangeChange', entry.onRange)
    } catch {
      // chart already disposed
    }
    for (const b of entry.bindings.values()) dispose(b)
    entry.bindings.clear()
    wired.delete(id)
  }

  /** Re-apply every binding, and fetch for any timeframe newly switched on. */
  const settingsChanged = (next: MtfConfig): void => {
    config = next
    configRev++
    saveMtfConfig(next)
    for (const entry of wired.values()) {
      for (const b of entry.bindings.values()) {
        apply(entry, b)
        void ensureCoverage(entry, b)
      }
    }
  }

  const openPanel = (paneId: string): boolean => {
    const entry = wired.get(paneId)
    if (!entry) return false
    // The gear is drawn on the chart's CANVAS, not in the DOM, so there is no element to
    // point at. The chart container is what the panel must live inside (it is what carries
    // the theme class the panel's tokens resolve against), but it is the full height of the
    // pane, so its own rect is the wrong place to hang the panel from -- under its bottom
    // edge is below the fold. Hence an explicit rect: the panel opens just under the
    // legend row at the chart's top left, which is where the gear that opened it is drawn.
    let anchor: HTMLElement | null = null
    try {
      anchor = entry.chart.getDom() as HTMLElement | null
    } catch {
      anchor = null
    }
    if (!anchor) return false
    const chartRect = anchor.getBoundingClientRect()
    panel?.close()
    panel = openSettingsPanel<MtfConfig>({
      anchor,
      // One legend row's worth below the top of the chart. Approximate on purpose: the
      // exact y of the gear depends on how many indicators the pane carries, and the panel
      // is clamped to the window anyway -- what matters is that it opens beside the chart's
      // legend rather than off the bottom of it.
      anchorRect: { top: chartRect.top, bottom: chartRect.top + LEGEND_ROW_HEIGHT, left: chartRect.left + 8 },
      title: 'AREV21 multi-timeframe',
      // No enable row: this overlay's on/off is the indicator being on the pane at all,
      // which the picker and the legend's own close icon already own. Omitting
      // onToggleEnabled is what suppresses the row -- see openSettingsPanel.
      fields: MTF_FIELDS,
      config,
      defaults: MTF_DEFAULTS,
      onChange: settingsChanged,
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  // Debug hook, mirroring window.__wdArev: what each pane's overlay currently holds --
  // read-only by convention, never used by the app itself.
  if (typeof window !== 'undefined') {
    window.__wdMtf = {
      debug: () =>
        [...wired.values()].flatMap((entry) =>
          [...entry.bindings.values()].map((b) => ({
            pane: entry.pane.id,
            chart: b.chartInterval,
            enabled: enabledIntervals(config),
            drawn: drawable(b),
            stores: Object.fromEntries(
              [...b.stores].map(([interval, store]) => [
                interval,
                { votes: store.values.size, gridBars: store.grid().length, phase: store.phase, error: store.error }
              ])
            )
          }))
        ),
      config: () => config
    }
  }

  return {
    sync(panes: ChartProPane[]): void {
      const live = new Map(panes.map((p) => [p.id, p]))
      for (const id of [...wired.keys()]) if (!live.has(id)) unwire(id)
      if (live.size === 0) {
        panel?.close()
        panel = null
      }
      for (const [id, p] of live) {
        const existing = wired.get(id)
        if (existing && existing.chart === p.getChart()) continue
        if (existing) unwire(id)
        wire(p)
      }
    },
    handleSettings({ indicatorName, paneId }): boolean {
      if (!isMtfIndicator(indicatorName)) return false
      return openPanel(paneId)
    }
  }
}

declare global {
  interface Window {
    __wdMtf?: { debug: () => unknown[]; config: () => unknown }
  }
}
