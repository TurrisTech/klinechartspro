import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { periodToResolution } from '../periods'
import { symbolVendor } from '../symbols'
import { fetchKrevValues, KREV_GENERATION, type KrevPoint } from './api'
import { dropStore, storeFor, type KrevStore, type Range } from './store'
import { isKrevIndicator, P_TEMPLATE_NAME, type ExtendData } from './templates'

// Keeps every KREV template fed: arev/controller.ts with one generation, no sub-pane and
// therefore no y-axis override — the template sits on the price pane, whose axis belongs
// to the candles. Per pane it watches the chart's own indicator list, and for the KREV
// template found fetches history for exactly the bar range the chart holds and nothing it
// already has, then hands the chart the values by bumping the indicator's extendData
// (which its `calc` reads back from the store). No live stream: the rows are written by a
// hand-run research script, so new data appears when it is re-run.

const POLL_MS = 500
const RANGE_DEBOUNCE_MS = 250
const MAX_VALUES_PER_REQUEST = 5000

interface Binding {
  indicatorId: string
  name: string
  chartPaneId: string
  vendor: string
  ticker: string
  interval: string
  signature: string
  storeKey: string
  store: KrevStore
  inFlight: Set<string>
  disposed: boolean
  lastAppliedRev: number
  lastShortName: string
}

interface WiredPane {
  pane: ChartProPane
  chart: Chart
  bindings: Map<string, Binding>
  poll: ReturnType<typeof setInterval>
  rangeTimer: ReturnType<typeof setTimeout> | null
  onRange: () => void
}

export interface KrevController {
  sync(panes: ChartProPane[]): void
}

export function createKrevController(): KrevController {
  const wired = new Map<string, WiredPane>()

  const label = (b: Binding): string => {
    const base = b.name === P_TEMPLATE_NAME ? `${KREV_GENERATION.toUpperCase()} P` : KREV_GENERATION.toUpperCase()
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
    if (rev === b.lastAppliedRev && shortName === b.lastShortName) return
    b.lastAppliedRev = rev
    b.lastShortName = shortName
    const extendData: ExtendData = { seriesKey: b.storeKey, rev }
    try {
      entry.chart.overrideIndicator({ id: b.indicatorId, name: b.name, paneId: b.chartPaneId, extendData, shortName } as never)
    } catch (err) {
      console.warn('[krev] override failed', err)
    }
  }

  const chartRange = (chart: Chart): Range | null => {
    const data = chart.getDataList()
    if (data.length === 0) return null
    return { from: data[0].timestamp, to: data[data.length - 1].timestamp + 1 }
  }

  const fetchGap = async (entry: WiredPane, b: Binding, gap: Range): Promise<void> => {
    const tag = `${gap.from}-${gap.to}`
    if (b.inFlight.has(tag)) return
    b.inFlight.add(tag)
    try {
      let from = gap.from
      let pages = 0
      while (from < gap.to && !b.disposed && pages < 20) {
        pages++
        const result = await fetchKrevValues(
          `${b.vendor}:${b.ticker}`,
          b.interval,
          from,
          gap.to,
          MAX_VALUES_PER_REQUEST
        )
        if (b.disposed) return
        if (result.s === 'no_data') {
          b.store.setMany([], { from, to: gap.to })
          b.store.setPhase('ready')
          apply(entry, b)
          return
        }
        const points: KrevPoint[] = result.points
        const last = points[points.length - 1]
        const full = points.length >= MAX_VALUES_PER_REQUEST
        // A capped page covers [from, last.date]; anything after it is fetched next round.
        b.store.setMany(points, { from, to: full && last ? last.date + 1 : gap.to })
        b.store.setPhase('ready')
        apply(entry, b)
        if (!full || !last) return
        from = last.date + 1
      }
    } catch (err) {
      b.store.setPhase('error', err instanceof Error ? err.message : String(err))
      apply(entry, b)
      console.error('[krev] history fetch failed', err)
    } finally {
      b.inFlight.delete(tag)
    }
  }

  const ensureCoverage = async (entry: WiredPane, b: Binding): Promise<void> => {
    if (b.disposed) return
    const range = chartRange(entry.chart)
    if (!range) return
    for (const gap of b.store.missing(range)) await fetchGap(entry, b, gap)
    apply(entry, b)
  }

  const dispose = (b: Binding): void => {
    b.disposed = true
    // Drop the store when nobody else on the wall shows this exact series.
    let used = false
    for (const e of wired.values()) for (const other of e.bindings.values()) if (other !== b && other.storeKey === b.storeKey) used = true
    if (!used) dropStore(b.storeKey)
  }

  const signatureOf = (ind: Pick<Indicator, 'name' | 'paneId'>, vendor: string, ticker: string, interval: string): string =>
    JSON.stringify([ind.name, ind.paneId, vendor, ticker, interval])

  const reconcile = (entry: WiredPane): void => {
    let indicators: Indicator[]
    try {
      indicators = entry.chart.getIndicators().filter((i) => isKrevIndicator(i.name))
    } catch {
      return
    }
    const symbol = entry.pane.getSymbol()
    const interval = periodToResolution(entry.pane.getPeriod())
    const vendor = symbolVendor(symbol)
    const seen = new Set<string>()
    for (const ind of indicators) {
      seen.add(ind.id)
      const sig = signatureOf(ind, vendor, symbol.ticker, interval)
      const existing = entry.bindings.get(ind.id)
      if (existing && existing.signature === sig) continue
      if (existing) {
        dispose(existing)
        entry.bindings.delete(ind.id)
      }
      const storeKey = `${KREV_GENERATION}|${vendor}:${symbol.ticker}|${interval}`
      const b: Binding = {
        indicatorId: ind.id,
        name: ind.name,
        chartPaneId: ind.paneId,
        vendor,
        ticker: symbol.ticker,
        interval,
        signature: sig,
        storeKey,
        store: storeFor(storeKey),
        inFlight: new Set(),
        disposed: false,
        lastAppliedRev: -1,
        lastShortName: ''
      }
      entry.bindings.set(ind.id, b)
      apply(entry, b)
      void ensureCoverage(entry, b)
    }
    for (const [id, b] of entry.bindings) {
      if (!seen.has(id)) {
        dispose(b)
        entry.bindings.delete(id)
      }
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

  // Debug hook, mirroring window.__wdIndicators: what each pane's KREV template
  // currently hold -- read-only by convention, never used by the app itself.
  if (typeof window !== 'undefined') {
    window.__wdKrev = {
      debug: () =>
        [...wired.values()].flatMap((entry) =>
          [...entry.bindings.values()].map((b) => ({
            pane: entry.pane.id,
            name: b.name,
            storeKey: b.storeKey,
            storeSize: b.store.values.size,
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
    __wdKrev?: { debug: () => unknown[] }
  }
}
