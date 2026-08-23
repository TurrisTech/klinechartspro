import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { periodToResolution, resolutionDurationMs } from '../periods'
import { symbolVendor } from '../symbols'
import { MTF_GENERATION, MTF_INTERVALS, fetchMtfBarGrid, fetchMtfPoints, type MtfInterval } from './api'
import { fromAbsolute, isFinerThan, toAbsolute } from './shift'
import { dropStore, storeFor, type MtfStore, type Range } from './store'
import { isMtfIndicator, parseTemplateName, type ExtendData } from './templates'

// Keeps every ticked AREV21 multi-timeframe overlay fed, the way arev/controller.ts does
// for the AREV panes: per pane it watches the chart's own indicator list, and for each
// MTF template found fetches exactly the source-timeframe window the chart needs and
// nothing it already has, then hands the chart the data by bumping the indicator's
// extendData (which its `calc` reads back from the store).
//
// Two things it does that the AREV controller does not, both consequences of the source
// timeframe not being the chart's:
//
//   * it fetches a BAR GRID as well as the votes, because placing a vote one source bar
//     forward is a question about the source timeframe's candle boundaries (shift.ts);
//   * it assigns each ticked timeframe a drawing LANE, so two overlays on one pane never
//     draw over each other. A template cannot do this for itself -- klinecharts gives a
//     `draw` callback no view of the other indicators on its pane -- and deriving it from
//     the timeframe's position in MTF_INTERVALS would leave gaps, putting a lone 1D
//     overlay in the eighth lane, 150-odd pixels off the candles it describes.
//
// Like AREV, there is nothing to subscribe: the rows are written by hand-run research
// scripts, not a live feed, so new votes appear when a script is re-run and a reload or a
// range change picks them up.

const POLL_MS = 500
const RANGE_DEBOUNCE_MS = 250
const MAX_VALUES_PER_REQUEST = 5000

// A fetch is widened past the chart's own span at both ends, and neither end is optional.
// FORWARD, because the newest vote in the window can only be placed once its successor
// bar is known, and that bar lies beyond the window by definition. BACKWARD, because a
// vote cast just before the window shifts INTO it. The floor covers the market's longest
// routine gap -- an FX weekend is ~65h, and a holiday can stretch it -- so a Friday vote's
// successor is always in reach.
const WINDOW_PAD_BARS = 4
const WINDOW_PAD_FLOOR_MS = 7 * 86_400_000

// `/getbars` is bounded by range, not by count, and 413s past the server's per-request bar
// cap. A gap is therefore fetched in chunks of at most this many NOMINAL source bars --
// nominal overcounts (the market is shut about a third of the week), so the real reply is
// always comfortably under the 5000 cap.
const GRID_CHUNK_BARS = 4000

interface Binding {
  indicatorId: string
  name: string
  chartPaneId: string
  sourceInterval: MtfInterval
  vendor: string
  ticker: string
  chartInterval: string
  signature: string
  storeKey: string
  store: MtfStore
  inFlight: Set<string>
  disposed: boolean
  lane: number
  lastAppliedRev: number
  lastShortName: string
  lastLane: number
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
}

export function createMtfController(): MtfController {
  const wired = new Map<string, WiredPane>()

  /** A source timeframe finer than the chart's is refused rather than drawn: hundreds of
   * sub-bar votes collapsing onto one candle reads as noise, not as context. The legend
   * is where that is said -- silently drawing nothing would be indistinguishable from a
   * timeframe no run has ever written. */
  const tooFine = (b: Binding): boolean => isFinerThan(b.sourceInterval, b.chartInterval)

  const label = (b: Binding): string => {
    const base = `A21 ${b.sourceInterval}`
    if (tooFine(b)) return `${base} · needs ≥ ${b.chartInterval} chart`
    switch (b.store.phase) {
      case 'idle':
      case 'loading':
        return `${base} · loading`
      case 'error':
        return `${base} · error`
      default:
        return base
    }
  }

  const apply = (entry: WiredPane, b: Binding): void => {
    if (b.disposed) return
    const rev = b.store.rev
    const shortName = label(b)
    if (rev === b.lastAppliedRev && shortName === b.lastShortName && b.lane === b.lastLane) return
    b.lastAppliedRev = rev
    b.lastShortName = shortName
    b.lastLane = b.lane
    const extendData: ExtendData = {
      seriesKey: b.storeKey,
      rev,
      chartInterval: b.chartInterval,
      lane: b.lane
    }
    try {
      entry.chart.overrideIndicator({ id: b.indicatorId, name: b.name, paneId: b.chartPaneId, extendData, shortName } as never)
    } catch (err) {
      console.warn('[mtf] override failed', err)
    }
  }

  /** The chart's loaded span, converted out of the chart's wire clock and into the source
   * timeframe's, padded at both ends. Both conversions are needed and they are different
   * whenever exactly one of the two intervals is daily-or-coarser -- see shift.ts. */
  const sourceWindow = (chart: Chart, b: Binding): Range | null => {
    const data = chart.getDataList()
    if (data.length === 0) return null
    const pad = Math.max(WINDOW_PAD_BARS * resolutionDurationMs(b.sourceInterval), WINDOW_PAD_FLOOR_MS)
    const absFrom = toAbsolute(b.chartInterval, data[0].timestamp) - pad
    const absTo = toAbsolute(b.chartInterval, data[data.length - 1].timestamp) + pad
    return {
      from: fromAbsolute(b.sourceInterval, absFrom),
      to: fromAbsolute(b.sourceInterval, absTo)
    }
  }

  const fetchGap = async (entry: WiredPane, b: Binding, gap: Range): Promise<void> => {
    const tag = `${gap.from}-${gap.to}`
    if (b.inFlight.has(tag)) return
    b.inFlight.add(tag)
    const vendorSymbol = `${b.vendor}:${b.ticker}`
    const chunk = GRID_CHUNK_BARS * resolutionDurationMs(b.sourceInterval)
    try {
      let from = gap.from
      let chunks = 0
      while (from < gap.to && !b.disposed && chunks < 20) {
        chunks++
        const to = Math.min(gap.to, from + chunk)
        // Votes and grid together, over one window, so a single range covers both in the
        // store. Concurrently, because neither depends on the other.
        const [points, grid] = await Promise.all([
          fetchMtfPoints(vendorSymbol, b.sourceInterval, from, to, MAX_VALUES_PER_REQUEST),
          fetchMtfBarGrid(vendorSymbol, b.sourceInterval, from, to)
        ])
        if (b.disposed) return
        b.store.setMany(points, grid, { from, to })
        b.store.setPhase('ready')
        apply(entry, b)
        from = to
      }
    } catch (err) {
      b.store.setPhase('error', err instanceof Error ? err.message : String(err))
      apply(entry, b)
      console.error('[mtf] history fetch failed', err)
    } finally {
      b.inFlight.delete(tag)
    }
  }

  const ensureCoverage = async (entry: WiredPane, b: Binding): Promise<void> => {
    if (b.disposed || tooFine(b)) return
    const window = sourceWindow(entry.chart, b)
    if (!window) return
    for (const gap of b.store.missing(window)) await fetchGap(entry, b, gap)
    apply(entry, b)
  }

  const dispose = (b: Binding): void => {
    b.disposed = true
    // Drop the store when nobody else on the wall reads this exact source series.
    let used = false
    for (const e of wired.values()) for (const other of e.bindings.values()) if (other !== b && other.storeKey === b.storeKey) used = true
    if (!used) dropStore(b.storeKey)
  }

  const signatureOf = (
    ind: Pick<Indicator, 'name' | 'paneId'>,
    vendor: string,
    ticker: string,
    chartInterval: string
  ): string => JSON.stringify([ind.name, ind.paneId, vendor, ticker, chartInterval])

  /** Lanes are handed out shortest-timeframe-first across whatever is ticked RIGHT NOW, so
   * the markers nearest the candles are always the ones from the timeframe nearest the
   * chart's own. */
  const assignLanes = (entry: WiredPane): boolean => {
    const ordered = [...entry.bindings.values()].sort(
      (a, b) => MTF_INTERVALS.indexOf(a.sourceInterval) - MTF_INTERVALS.indexOf(b.sourceInterval)
    )
    let changed = false
    ordered.forEach((b, index) => {
      if (b.lane !== index) {
        b.lane = index
        changed = true
      }
    })
    return changed
  }

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
      const sig = signatureOf(ind, vendor, symbol.ticker, chartInterval)
      const existing = entry.bindings.get(ind.id)
      if (existing && existing.signature === sig) continue
      if (existing) {
        dispose(existing)
        entry.bindings.delete(ind.id)
      }
      const sourceInterval = parseTemplateName(ind.name)
      if (!sourceInterval) continue
      // Keyed by the SOURCE timeframe only: what is being read is the 1D votes, whatever
      // interval the chart in front of them happens to be on.
      const storeKey = `${MTF_GENERATION}|${vendor}:${symbol.ticker}|${sourceInterval}`
      const b: Binding = {
        indicatorId: ind.id,
        name: ind.name,
        chartPaneId: ind.paneId,
        sourceInterval,
        vendor,
        ticker: symbol.ticker,
        chartInterval,
        signature: sig,
        storeKey,
        store: storeFor(storeKey),
        inFlight: new Set(),
        disposed: false,
        lane: 0,
        lastAppliedRev: -1,
        lastShortName: '',
        lastLane: -1
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
    // Untick one of three overlays and the two that remain move up a lane, so every
    // binding is re-applied when the assignment shifts, not just the new ones.
    const lanesChanged = assignLanes(entry)
    if (lanesChanged) for (const b of entry.bindings.values()) apply(entry, b)
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

  // Debug hook, mirroring window.__wdArev: what each pane's MTF overlays currently hold --
  // read-only by convention, never used by the app itself.
  if (typeof window !== 'undefined') {
    window.__wdMtf = {
      debug: () =>
        [...wired.values()].flatMap((entry) =>
          [...entry.bindings.values()].map((b) => ({
            pane: entry.pane.id,
            name: b.name,
            source: b.sourceInterval,
            chart: b.chartInterval,
            lane: b.lane,
            storeKey: b.storeKey,
            votes: b.store.values.size,
            gridBars: b.store.grid().length,
            phase: b.store.phase,
            error: b.store.error
          }))
        )
    }
  }

  return {
    sync(panes: ChartProPane[]): void {
      const live = new Map(panes.map((p) => [p.id, p]))
      for (const id of [...wired.keys()]) if (!live.has(id)) unwire(id)
      for (const [id, p] of live) {
        const existing = wired.get(id)
        if (existing && existing.chart === p.getChart()) continue
        if (existing) unwire(id)
        wire(p)
      }
    }
  }
}

declare global {
  interface Window {
    __wdMtf?: { debug: () => unknown[] }
  }
}
