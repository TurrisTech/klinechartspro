import type { IndicatorGroup } from '../../src'
import { apiUrl } from '../config'
import { resolveSeries, type IndicatorPoint, type SeriesDoc } from '../indicators/api'
import { fetchEnvelope, toPage } from '../plugins/api'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  IndicatorPlugin,
  PluginFacilities,
  SourceNotify,
  SourceSpec,
  SourceStore,
  ValidateRequest
} from '../plugins/types'
import type { Feature } from '../capabilities'
import type { IndicatorListener } from '../stream'
import { loadRegistry, type RegistryIndicator } from './api'
import { registrySourceKey, storeFactory, type RegistryPoint, type RegistryStore } from './store'
import { defaultCalcParams, drawnSeries, PALETTE, registerRegistryIndicators, seriesDocFor } from './templates'

// The one client plugin for every server indicator: it reads the registry, registers a
// template per row, and binds each one to the wire its row names.
//
// This is what replaced `client/arev/`, `client/krev/` and `client/indicators/`'s plugin
// and template halves -- three modules that were structural copies differing in their
// colours, their thresholds and which route they fetched. Adding an indicator is now a row
// in `indicators.ts_indicator`; nothing here learns its name.
//
// Two wires, because an entry may be served by a reader that predates the registry:
//
//   * `indicators` -- the computable library. A template's `calcParams` resolve to a node
//     document, the points come from `/indicators/values`, and the series is SUBSCRIBED, so
//     a live bar's value lands in the same store the history did. The client stays ignorant
//     of whether the server computed it on demand or read it from a store.
//   * anything else -- the unified `GET /plugins/{id}/values?variant=`. The AREV generations
//     and krev01 keep being served by the plugins that own their published signal refs and
//     their legacy alias paths; a new indicator is served by the generic `ts` reader. There
//     is nothing to subscribe on either: the rows are written by hand-run research scripts,
//     so new data appears on a reload or a range change.

/** Store identity for a `computed` entry. The params are part of it -- a params change is a
 * different series and therefore a different store, not a refetch of the same one. */
export function seriesSourceKey(
  vendor: string,
  ticker: string,
  interval: string,
  series: SeriesDoc
): string {
  return `S|${vendor}:${ticker}|${interval}|${JSON.stringify(series)}`
}

function computedSource(
  f: PluginFacilities,
  entry: RegistryIndicator,
  ctx: BindContext,
  calcParams: unknown[]
): SourceSpec<RegistryPoint> {
  const series = seriesDocFor(entry, calcParams)
  const key = seriesSourceKey(ctx.vendor, ctx.ticker, ctx.interval, series)
  return {
    id: 'value',
    key,
    resolution: ctx.interval,
    createStore: storeFactory(null),
    fetch: async (range, limit) => {
      const url = apiUrl('/indicators/values', {
        symbol: `${ctx.vendor}:${ctx.ticker}`,
        resolution: ctx.interval,
        series: JSON.stringify(series),
        from: range.from,
        to: range.to,
        limit
      })
      return toPage(await fetchEnvelope<RegistryPoint>(url), limit)
    },
    // Subscribed at bind time, before the first fetch, so a live point arriving during the
    // history read is not lost.
    subscribe: (store: SourceStore<RegistryPoint>, notify: SourceNotify) => {
      const s = store as RegistryStore
      const listener: IndicatorListener = {
        onBackfill: (points: IndicatorPoint[]) => {
          if (points.length === 0) return
          s.ingest(points, {
            from: points[0].date,
            to: points[points.length - 1].date + 1
          })
          notify.changed()
        },
        onPoint: (point: IndicatorPoint) => {
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
}

/** The source for one stored indicator on one instrument and interval -- shared with the
 * MTF overlay, which reads arev21 at intervals that are not the chart's. Exported so the
 * test that locks that sharing can name it. */
export function storedSource(f: PluginFacilities, entry: RegistryIndicator, ctx: BindContext): SourceSpec<RegistryPoint> {
  return {
    id: entry.name,
    key: registrySourceKey(entry.name, ctx.vendor, ctx.ticker, ctx.interval),
    resolution: ctx.interval,
    // The one factory for this fold -- the AREV21 MTF overlay names the same one, so
    // whichever binding arrives first the class and the row shape are the same
    // (`store.ts`).
    createStore: storeFactory(entry.source.fold_by),
    fetch: (range, limit) =>
      f.points<RegistryPoint>({
        pluginId: entry.wire.plugin,
        vendorSymbol: `${ctx.vendor}:${ctx.ticker}`,
        resolution: ctx.interval,
        from: range.from,
        to: range.to,
        limit,
        variant: entry.wire.variant ?? undefined
      })
  }
}

export function createRegistryPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let byTemplate = new Map<string, RegistryIndicator>()

  return {
    id: 'registry',
    // Always mounted: the registry is the catalogue, and which INDICATORS it offers is
    // decided per row by that row's own feature. A server with no registry answers an empty
    // list and the picker simply has no server indicators, which is the honest degrade.
    feature: null,
    async register(f: PluginFacilities): Promise<IndicatorGroup[]> {
      facilities = f
      const entries = (await loadRegistry()).filter(
        (e) => e.enabled && (e.feature == null || f.hasFeature(e.feature as Feature))
      )
      byTemplate = new Map(entries.map((e) => [e.template, e]))
      return registerRegistryIndicators(entries)
    },
    matches: (name: string) => byTemplate.has(name),
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      const entry = byTemplate.get(ctx.indicator.name)
      if (!f || !entry) return null
      const computed = entry.wire.plugin === 'indicators'
      const calcParams = computed
        ? ctx.indicator.calcParams.map((v, i) =>
            typeof v === 'number' && Number.isFinite(v) ? v : defaultCalcParams(entry)[i]
          )
        : []
      const source = computed ? computedSource(f, entry, ctx, calcParams) : storedSource(f, entry, ctx)

      // Main-pane lines format like price.
      const overrides: Record<string, unknown> = {}
      if (entry.pane === 'main' && typeof ctx.symbol.pricePrecision === 'number') {
        overrides.precision = ctx.symbol.pricePrecision
      }
      // And each single-line indicator on a pane takes the next colour, so two moving
      // averages differing only in their window are told apart. A row with several lines
      // (a model's pane, where each line means something different) keeps the colours the
      // registry gave it.
      if (drawnSeries(entry).length === 1) {
        const nth = ctx.siblings.filter((s) => {
          const sibling = byTemplate.get(s.name)
          return sibling != null && drawnSeries(sibling).length === 1
        }).length
        overrides.styles = { lines: [{ color: PALETTE[nth % PALETTE.length] }] }
      }

      return {
        sources: [source],
        // klinecharts renders `${shortName}(${calcParams})` itself, so the label carries the
        // title and the source's state, never the params.
        label: (state: BindingState) => {
          const store = state.sources[0]?.store
          if (!store) return `${entry.title} · loading`
          switch (store.phase) {
            case 'idle':
            case 'loading':
              return `${entry.title} · loading`
            case 'queued':
              return `${entry.title} · queued`
            case 'replaying':
              return `${entry.title} · computing${store.progress != null ? ` ${Math.round(store.progress * 100)}%` : '…'}`
            case 'error':
              return `${entry.title} · error`
            default:
              return entry.title
          }
        },
        overrides,
        yAxisGap: entry.axisGap ?? undefined
      }
    },
    /** The settings dialog asks this before it will commit params, so a combination the
     * server cannot serve is refused with its own explanation instead of being drawn and
     * then failing on the first fetch. Only a `computed` entry has params to check; behaves
     * as if nobody were checking against a server without `indicators.resolve`. */
    async validateParams(request: ValidateRequest) {
      const entry = byTemplate.get(request.indicatorName)
      const f = facilities
      if (!entry || !f || entry.wire.plugin !== 'indicators' || !f.hasFeature('indicators.resolve')) {
        return { ok: true }
      }
      const vendorSymbol = `${f.symbolVendor(request.symbol)}:${request.symbol.ticker}`
      const result = await resolveSeries(
        vendorSymbol,
        request.period.text,
        seriesDocFor(entry, request.calcParams)
      )
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
