import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane, SymbolInfo } from '../../src'
import { periodToResolution } from '../periods'
import { stream, type IndicatorListener } from '../stream'
import { symbolVendor } from '../symbols'
import { fetchValues, type IndicatorPoint, type IndicatorSpec, type SeriesDoc } from './api'
import { dropStore, storeFor, type Range, type SeriesStore } from './store'
import {
  defaultCalcParams,
  isServerIndicator,
  LINE_COLORS,
  parseTemplateName,
  seriesDocFor,
  templateName,
  type ExtendData,
  type Value
} from './templates'

// Keeps every server indicator on every live pane fed. Per pane it watches the chart's own
// indicator list (klinecharts is the source of truth for "what is on this pane": the library's
// picker/settings dialogs create, remove and re-parameterise indicators without telling anyone),
// and for each server template found: resolves the series (instrument + interval + params →
// SeriesDoc), fetches history for exactly the bar range the chart holds and nothing it already
// has, subscribes to live values over the shared stream, and hands the chart the values by
// bumping the indicator's extendData (which its `calc` reads back from the store). A change of
// symbol, period or params under a pane simply resolves to a different series; the old one is
// released. The client stays ignorant of ephemeral vs persisted throughout.

const POLL_MS = 500
const RANGE_DEBOUNCE_MS = 250
const MAX_VALUES_PER_REQUEST = 5000

interface Binding {
  indicatorId: string
  name: string
  chartPaneId: string
  spec: IndicatorSpec
  calcParams: number[]
  signature: string
  vendor: string
  ticker: string
  interval: string
  series: SeriesDoc
  seriesKey: string | null
  store: SeriesStore | null
  listener: IndicatorListener | null
  inFlight: Set<string>
  retryTimer: ReturnType<typeof setTimeout> | null
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

export interface IndicatorController {
  sync(panes: ChartProPane[]): void
}

export function createIndicatorController(specs: IndicatorSpec[]): IndicatorController {
  const specByName = new Map(specs.map((s) => [templateName(s), s]))
  const wired = new Map<string, WiredPane>()

  // klinecharts renders `${shortName}(${calcParams})` itself, so the label carries the title
  // and the series' state, never the params.
  const label = (b: Binding): string => {
    const base = b.spec.title
    const s = b.store
    if (!s) return `${base} · loading`
    switch (s.phase) {
      case 'queued':
        return `${base} · queued`
      case 'replaying':
        return `${base} · computing${s.progress != null ? ` ${Math.round(s.progress * 100)}%` : '…'}`
      case 'loading':
        return `${base} · loading`
      case 'error':
        return `${base} · error`
      default:
        return base
    }
  }

  const apply = (entry: WiredPane, b: Binding): void => {
    if (b.disposed || !b.store) return
    const rev = b.store.rev
    const shortName = label(b)
    if (rev === b.lastAppliedRev && shortName === b.lastShortName) return
    b.lastAppliedRev = rev
    b.lastShortName = shortName
    const extendData: ExtendData = { seriesKey: b.seriesKey ?? '', rev }
    try {
      entry.chart.overrideIndicator({ id: b.indicatorId, name: b.name, paneId: b.chartPaneId, extendData, shortName } as never)
    } catch (err) {
      console.warn('[indicators] override failed', err)
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
        const result = await fetchValues(`${b.vendor}:${b.ticker}`, b.interval, b.series, from, gap.to, MAX_VALUES_PER_REQUEST)
        if (b.disposed) return
        if (b.seriesKey === null) attachSeries(entry, b, result.seriesKey)
        else if (b.seriesKey !== result.seriesKey) return // stale (params changed meanwhile)
        const store = b.store
        if (!store) return
        if (result.s === 'replaying') {
          store.setPhase(result.phase === 'queued' ? 'queued' : 'replaying', result.progress ?? null)
          apply(entry, b)
          if (b.retryTimer) clearTimeout(b.retryTimer)
          b.retryTimer = setTimeout(() => {
            b.retryTimer = null
            b.inFlight.delete(tag)
            void ensureCoverage(entry, b)
          }, Math.max(500, result.retryAfterMs ?? 1500))
          return
        }
        if (result.s === 'no_data') {
          store.setMany([], { from, to: gap.to })
          store.setPhase('ready')
          apply(entry, b)
          return
        }
        const points: IndicatorPoint[] = result.points
        const last = points[points.length - 1]
        const full = points.length >= MAX_VALUES_PER_REQUEST
        // A capped page covers [from, last.date]; anything after it is fetched next round.
        store.setMany(points, { from, to: full && last ? last.date + 1 : gap.to })
        store.setPhase('ready')
        apply(entry, b)
        if (!full || !last) return
        from = last.date + 1
      }
    } catch (err) {
      const store = b.store
      if (store) {
        store.setPhase('error', null, err instanceof Error ? err.message : String(err))
        apply(entry, b)
      }
      console.error('[indicators] history fetch failed', err)
    } finally {
      b.inFlight.delete(tag)
    }
  }

  const ensureCoverage = async (entry: WiredPane, b: Binding): Promise<void> => {
    if (b.disposed) return
    const range = chartRange(entry.chart)
    if (!range) return
    if (!b.store) {
      // First contact: one read resolves the seriesKey and seeds the store.
      await fetchGap(entry, b, range)
      return
    }
    for (const gap of b.store.missing(range)) await fetchGap(entry, b, gap)
    apply(entry, b)
  }

  const attachSeries = (entry: WiredPane, b: Binding, seriesKey: string): void => {
    b.seriesKey = seriesKey
    b.store = storeFor(seriesKey)
    const store = b.store
    const listener: IndicatorListener = {
      onBackfill: (points) => {
        if (points.length === 0) return
        store.setMany(points, { from: points[0].date, to: points[points.length - 1].date + 1 })
        apply(entry, b)
      },
      onPoint: (point) => {
        store.set(point)
        apply(entry, b)
      },
      onStatus: (phase, error) => {
        if (phase === 'ready' && store.phase !== 'ready') {
          store.setPhase('ready')
          void ensureCoverage(entry, b)
        } else if (phase === 'error') {
          store.setPhase('error', null, error)
        } else if (phase === 'replaying' || phase === 'queued') {
          store.setPhase(phase, store.progress)
        }
        apply(entry, b)
      }
    }
    b.listener = listener
    stream.subscribeIndicator(b.vendor, b.ticker, b.interval, b.series, seriesKey, listener)
    apply(entry, b)
  }

  const dispose = (b: Binding): void => {
    b.disposed = true
    if (b.retryTimer) clearTimeout(b.retryTimer)
    if (b.seriesKey && b.listener) stream.unsubscribeIndicator(b.seriesKey, b.listener)
    // Drop the store when nobody else on the wall shows this exact series.
    if (b.seriesKey) {
      let used = false
      for (const e of wired.values()) for (const other of e.bindings.values()) if (other !== b && other.seriesKey === b.seriesKey) used = true
      if (!used) dropStore(b.seriesKey)
    }
  }

  const bind = (entry: WiredPane, ind: Indicator<Value, number, ExtendData>, symbol: SymbolInfo, interval: string): Binding => {
    const spec = specByName.get(ind.name)
    if (!spec) throw new Error(`no spec for ${ind.name}`)
    const calcParams = ind.calcParams.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? v : defaultCalcParams(spec)[i]))
    const vendor = symbolVendor(symbol)
    const b: Binding = {
      indicatorId: ind.id,
      name: ind.name,
      chartPaneId: ind.paneId,
      spec,
      calcParams,
      signature: signatureOf(ind, vendor, symbol.ticker, interval),
      vendor,
      ticker: symbol.ticker,
      interval,
      series: seriesDocFor(spec, calcParams),
      seriesKey: null,
      store: null,
      listener: null,
      inFlight: new Set(),
      retryTimer: null,
      disposed: false,
      lastAppliedRev: -1,
      lastShortName: ''
    }
    // Main-pane indicators format like price; each server line on a pane gets its own colour
    // (by order of appearance) so two moving averages never share one.
    const patch: Record<string, unknown> = {}
    if (spec.pane === 'main' && typeof symbol.pricePrecision === 'number') patch.precision = symbol.pricePrecision
    if (spec.render === 'line') {
      const nth = [...entry.bindings.values()].filter((o) => o.spec.render === 'line').length
      patch.styles = { lines: [{ color: LINE_COLORS[nth % LINE_COLORS.length] }] }
    }
    if (Object.keys(patch).length > 0) {
      try {
        entry.chart.overrideIndicator({ id: ind.id, name: ind.name, paneId: ind.paneId, ...patch } as never)
      } catch {
        // ignore
      }
    }
    return b
  }

  const signatureOf = (ind: Pick<Indicator, "name" | "paneId" | "calcParams">, vendor: string, ticker: string, interval: string): string =>
    JSON.stringify([ind.name, ind.paneId, ind.calcParams, vendor, ticker, interval])

  const reconcile = (entry: WiredPane): void => {
    let indicators: Indicator[]
    try {
      indicators = entry.chart.getIndicators().filter((i) => isServerIndicator(i.name))
    } catch {
      return
    }
    const symbol = entry.pane.getSymbol()
    const interval = periodToResolution(entry.pane.getPeriod())
    const vendor = symbolVendor(symbol)
    const seen = new Set<string>()
    for (const ind of indicators) {
      seen.add(ind.id)
      // No parameter restoration here any more: a persisted series' calcParams are part of the
      // wall document (client/layout.ts's `ip`), and the library applies them when it CREATES
      // the indicator -- so what this reads is already the user's own numbers, on the first
      // poll, with no window ever fetched for the template default. See the note on
      // Workspace.indicatorParams in client/workspaces/store.ts for the shape this replaced.
      const sig = signatureOf(ind, vendor, symbol.ticker, interval)
      const existing = entry.bindings.get(ind.id)
      if (existing && existing.signature === sig) {
        continue
      }
      if (existing) {
        dispose(existing)
        entry.bindings.delete(ind.id)
      }
      if (!specByName.has(ind.name)) continue
      const b = bind(entry, ind as Indicator<Value, number, ExtendData>, symbol, interval)
      entry.bindings.set(ind.id, b)
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

  // Debug hook (see store.ts): what each pane's server indicators currently resolve to.
  if (typeof window !== 'undefined') {
    window.__wdIndicators = {
      ...(window.__wdIndicators ?? { stores: new Map() }),
      debug: () =>
        [...wired.values()].flatMap((entry) =>
          [...entry.bindings.values()].map((b) => {
            const ind = entry.chart.getIndicators({ id: b.indicatorId })[0] as
              | Indicator<Value, number, ExtendData>
              | undefined
            return {
              pane: entry.pane.id,
              name: b.name,
              seriesKey: b.seriesKey,
              storeSize: b.store?.values.size ?? 0,
              phase: b.store?.phase,
              extendData: ind?.extendData,
              resultValues: ind?.result.filter((r) => r.value != null).length ?? 0,
              resultLength: ind?.result.length ?? 0
            }
          })
        )
    }
  }

  return {
    sync(panes: ChartProPane[]): void {
      // Pane POSITION is no longer part of this: it was only ever here to index into the
      // pane-index-keyed parameter map that the wall document replaced, and a pane's identity
      // is its id.
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

export { parseTemplateName }
