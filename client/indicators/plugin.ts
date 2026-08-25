import type { IndicatorGroup } from '../../src'
import { apiUrl } from '../config'
import { fetchEnvelope, toPage } from '../plugins/api'
import { WindowStore } from '../plugins/store'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  IndicatorPlugin,
  PluginFacilities,
  SourceNotify,
  SourceStore,
  ValidateRequest
} from '../plugins/types'
import type { IndicatorListener } from '../stream'
import { loadDiscovery, resolveSeries, type IndicatorPoint, type IndicatorSpec, type SeriesDoc } from './api'
import {
  defaultCalcParams,
  isServerIndicator,
  LINE_COLORS,
  registerServerIndicators,
  seriesDocFor,
  templateName
} from './templates'

// The registry series as a client plugin: one `S:<name>@<version>` template per catalogue
// entry, each reading one source -- the series the template + calcParams resolve to on the
// pane's instrument and interval. The source is fetched off `/indicators/values` (the
// server's `indicators` plugin keeps its own richer routes: resolve, batch, the WS frames)
// and subscribed over the shared stream, so a live bar's value lands in the same store
// the history did. The client stays ignorant of ephemeral vs persisted throughout.

export function seriesSourceKey(vendor: string, ticker: string, interval: string, series: SeriesDoc): string {
  return `S|${vendor}:${ticker}|${interval}|${JSON.stringify(series)}`
}

export function createIndicatorsPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let specByName = new Map<string, IndicatorSpec>()
  let canResolve = false

  return {
    id: 'indicators',
    feature: 'indicators',
    async register(f: PluginFacilities): Promise<IndicatorGroup[]> {
      facilities = f
      canResolve = f.hasFeature('indicators.resolve')
      const discovery = await loadDiscovery()
      const specs = discovery.indicators
      specByName = new Map(specs.map((s) => [templateName(s), s]))
      return registerServerIndicators(specs)
    },
    matches: (name) => isServerIndicator(name) && specByName.has(name),
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      const spec = specByName.get(ctx.indicator.name)
      if (!f || !spec) return null
      const calcParams = ctx.indicator.calcParams.map((v, i) =>
        typeof v === 'number' && Number.isFinite(v) ? v : defaultCalcParams(spec)[i]
      )
      const series = seriesDocFor(spec, calcParams)
      const vendorSymbol = `${ctx.vendor}:${ctx.ticker}`
      const key = seriesSourceKey(ctx.vendor, ctx.ticker, ctx.interval, series)

      // Main-pane indicators format like price; each server line on a pane gets its own
      // colour (by order of appearance) so two moving averages never share one.
      const overrides: Record<string, unknown> = {}
      if (spec.pane === 'main' && typeof ctx.symbol.pricePrecision === 'number') overrides.precision = ctx.symbol.pricePrecision
      if (spec.render === 'line') {
        const nth = ctx.siblings.filter((s) => specByName.get(s.name)?.render === 'line').length
        overrides.styles = { lines: [{ color: LINE_COLORS[nth % LINE_COLORS.length] }] }
      }

      return {
        sources: [
          {
            id: 'value',
            key,
            createStore: (k) => new WindowStore<IndicatorPoint, number | null>(k, (p) => p.value),
            fetch: async (range, limit) => {
              const url = apiUrl('/indicators/values', {
                symbol: vendorSymbol,
                resolution: ctx.interval,
                series: JSON.stringify(series),
                from: range.from,
                to: range.to,
                limit
              })
              return toPage(await fetchEnvelope<IndicatorPoint>(url), limit)
            },
            subscribe: (store: SourceStore<IndicatorPoint>, notify: SourceNotify) => {
              const s = store as WindowStore<IndicatorPoint, number | null>
              const listener: IndicatorListener = {
                onBackfill: (points) => {
                  if (points.length === 0) return
                  s.ingest(points, { from: points[0].date, to: points[points.length - 1].date + 1 })
                  notify.changed()
                },
                onPoint: (point) => {
                  s.set(point)
                  notify.changed()
                },
                onStatus: (phase, error) => {
                  if (phase === 'ready' && s.phase !== 'ready') {
                    s.setPhase('ready')
                    notify.refetch()
                  } else if (phase === 'error') {
                    s.setPhase('error', null, error)
                  } else if (phase === 'replaying' || phase === 'queued') {
                    s.setPhase(phase, s.progress)
                  }
                  notify.changed()
                }
              }
              f.stream.subscribeIndicator(ctx.vendor, ctx.ticker, ctx.interval, series, key, listener)
              return () => f.stream.unsubscribeIndicator(key, listener)
            }
          }
        ],
        // klinecharts renders `${shortName}(${calcParams})` itself, so the label carries the
        // title and the series' state, never the params.
        label: (state: BindingState) => {
          const base = spec.title
          const s = state.sources[0]?.store
          if (!s) return `${base} · loading`
          switch (s.phase) {
            case 'idle':
            case 'loading':
              return `${base} · loading`
            case 'queued':
              return `${base} · queued`
            case 'replaying':
              return `${base} · computing${s.progress != null ? ` ${Math.round(s.progress * 100)}%` : '…'}`
            case 'error':
              return `${base} · error`
            default:
              return base
          }
        },
        overrides
      }
    },
    /** The settings dialog asks this before it will commit params, so a combination the
     * server cannot serve is refused with its own explanation instead of being drawn and
     * then failing on the first fetch. Behaves as if nobody were checking against a server
     * without `indicators.resolve`. */
    async validateParams(request: ValidateRequest) {
      const spec = specByName.get(request.indicatorName)
      if (!spec || !canResolve || !facilities) return { ok: true }
      const vendorSymbol = `${facilities.symbolVendor(request.symbol)}:${request.symbol.ticker}`
      const result = await resolveSeries(vendorSymbol, request.period.text, seriesDocFor(spec, request.calcParams))
      if (!result) return { ok: true } // unanswerable: behave as if nobody were checking
      if (!result.servable) return { ok: false, reason: result.reason }
      // A servable series still has a cost worth showing: the lead-in scales with the
      // look-back, so "window 5000" quietly means reading thousands of extra bars per draw.
      const hint =
        result.mode === 'persisted'
          ? 'Served from the store.'
          : `Computed on demand; needs ${result.warmupBars.toLocaleString()} bars of warm-up.`
      return { ok: true, hint }
    }
  }
}
