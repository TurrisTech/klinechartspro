import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane, IndicatorGroup, IndicatorParamsCheck } from '../../src'
import { dropStore, forgetAllAfter, storeFor, WindowStore } from './store'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  BoundSource,
  IndicatorPlugin,
  PluginFacilities,
  Range,
  SettingsRequest,
  SourceSpec,
  SourceStore,
  ValidateRequest
} from './types'

// The plugin host: one controller for every indicator plugin on every live pane.
//
// Per pane it watches the chart's own indicator list (klinecharts is the source of truth for
// "what is on this pane": the library's picker/settings dialogs create, remove and
// re-parameterise indicators without telling anyone), and for each indicator a plugin claims
// it asks that plugin for a binding: which sources to read. It then keeps every source
// covered for exactly the bar range the chart holds and nothing it already has (paged),
// subscribed where the source offers it, and hands the chart the values by bumping the
// indicator's extendData (which the plugin's `calc` reads back from the stores). A change
// of symbol, period, params or plugin signature under a pane rebinds; the old sources are
// released, and a store is dropped when no binding on the wall reads it any more.
//
// Built per MOUNT, not once per page: it holds per-pane state keyed by pane id, and
// `sync([])` at teardown is the only signal it gets.

const POLL_MS = 500
const RANGE_DEBOUNCE_MS = 250
const MAX_PAGES_PER_GAP = 20

interface Binding {
  plugin: IndicatorPlugin
  indicatorId: string
  name: string
  chartPaneId: string
  signature: string
  /** Monotonic per host; folded into `rev` so a rebind always reaches the template. */
  seq: number
  spec: BindingSpec
  sources: Array<BoundSource & { spec: SourceSpec; unsubscribe: (() => void) | null }>
  state: BindingState
  inFlight: Set<string>
  retryTimer: ReturnType<typeof setTimeout> | null
  disposed: boolean
  lastAppliedRev: number
  lastShortName: string
}

interface WiredPane {
  pane: ChartProPane
  paneIndex: number
  chart: Chart
  bindings: Map<string, Binding>
  poll: ReturnType<typeof setInterval>
  rangeTimer: ReturnType<typeof setTimeout> | null
  onRange: () => void
}

export interface PluginHost {
  /** The picker groups every registered plugin contributed, in registry order. */
  readonly groups: IndicatorGroup[]
  /** The plugins that registered (their feature was advertised). */
  readonly plugins: IndicatorPlugin[]
  sync(panes: ChartProPane[]): void
  /** ChartProOptions.indicatorSettingsHandler. */
  handleSettings(request: SettingsRequest): boolean
  /** ChartProOptions.indicatorParamsValidator, or null when no plugin validates. */
  readonly validateParams: ((request: ValidateRequest) => Promise<IndicatorParamsCheck>) | null
  /** Per-plugin, per-pane document state -- what the wall document persists. */
  paneState(): Record<string, Record<number, unknown>>
  /** The read clock moved forward past `from` (a replay step): forget every store's
   * coverage from there and re-cover every binding. */
  invalidateFrom(from: number): void
  teardown(): void
}

export interface HostFacilities extends Omit<PluginFacilities, 'paneInfo' | 'requestReconcile'> {
  /** Supplied by the host. */
  paneInfo?: PluginFacilities['paneInfo']
  requestReconcile?: PluginFacilities['requestReconcile']
}

export interface CreateHostOptions {
  plugins: IndicatorPlugin[]
  facilities: HostFacilities
  /** What the wall document hydrated per plugin (by plugin id, then pane index). */
  paneState?: Record<string, Record<number, unknown>>
}

export async function createPluginHost(options: CreateHostOptions): Promise<PluginHost> {
  const wired = new Map<string, WiredPane>()
  const facilities = options.facilities as PluginFacilities
  let seq = 0

  // The host completes the facilities: a plugin may ask for a pane or a reconcile only
  // once the host exists, and both are answered from its own tables.
  facilities.paneInfo = (paneId) => {
    const entry = wired.get(paneId)
    return entry ? { chart: entry.chart, pane: entry.pane, paneIndex: entry.paneIndex } : null
  }
  facilities.requestReconcile = (paneId) => {
    if (paneId) {
      const entry = wired.get(paneId)
      if (entry) reconcile(entry)
      return
    }
    for (const entry of wired.values()) reconcile(entry)
  }

  const plugins: IndicatorPlugin[] = []
  const groups: IndicatorGroup[] = []
  for (const plugin of options.plugins) {
    if (plugin.feature !== null && !facilities.hasFeature(plugin.feature)) continue
    try {
      groups.push(...(await plugin.register(facilities)))
      plugin.paneState?.hydrate(options.paneState?.[plugin.id] ?? {})
      plugins.push(plugin)
    } catch (err) {
      // A plugin that cannot register (its catalogue failed to load, say) contributes
      // nothing; the others must not go down with it.
      console.error(`[plugins] ${plugin.id} failed to register`, err)
    }
  }

  const pluginFor = (name: string): IndicatorPlugin | undefined => plugins.find((p) => p.matches(name))

  const chartRange = (chart: Chart): Range | null => {
    const data = chart.getDataList()
    if (data.length === 0) return null
    return { from: data[0].timestamp, to: data[data.length - 1].timestamp + 1 }
  }

  const aggregateRev = (b: Binding): number => {
    let rev = b.seq * 1_000_003
    for (const s of b.sources) rev += s.store.rev
    return rev
  }

  const apply = (entry: WiredPane, b: Binding): void => {
    if (b.disposed) return
    const rev = aggregateRev(b)
    let shortName: string
    try {
      shortName = b.spec.label(b.state)
    } catch (err) {
      console.warn(`[plugins] ${b.plugin.id} label failed`, err)
      shortName = b.name
    }
    if (rev === b.lastAppliedRev && shortName === b.lastShortName) return
    b.lastAppliedRev = rev
    b.lastShortName = shortName
    const seriesKeys: Record<string, string> = {}
    for (const s of b.sources) seriesKeys[s.id] = s.key
    const extendData = {
      seriesKey: b.sources[0]?.key ?? '',
      seriesKeys,
      rev,
      ...(b.spec.extendData?.(b.state) ?? {})
    }
    try {
      entry.chart.overrideIndicator({ id: b.indicatorId, name: b.name, paneId: b.chartPaneId, extendData, shortName } as never)
    } catch (err) {
      console.warn(`[plugins] ${b.plugin.id} override failed`, err)
    }
  }

  const scheduleRetry = (entry: WiredPane, b: Binding, afterMs: number): void => {
    if (b.retryTimer) clearTimeout(b.retryTimer)
    b.retryTimer = setTimeout(() => {
      b.retryTimer = null
      void ensureCoverage(entry, b)
    }, Math.max(500, afterMs))
  }

  const fetchGap = async (entry: WiredPane, b: Binding, source: Binding['sources'][number], gap: Range): Promise<void> => {
    const tag = `${source.id}|${gap.from}-${gap.to}`
    if (b.inFlight.has(tag)) return
    b.inFlight.add(tag)
    const store = source.store
    try {
      let from = gap.from
      let pages = 0
      while (from < gap.to && !b.disposed && pages < MAX_PAGES_PER_GAP) {
        pages++
        const page = await source.spec.fetch({ from, to: gap.to }, facilities.maxValuesPerRequest)
        if (b.disposed) return
        if (page.status) {
          store.setPhase(page.status.phase, page.status.progress)
          apply(entry, b)
          scheduleRetry(entry, b, page.status.retryAfterMs)
          return
        }
        const to = page.nextFrom ?? gap.to
        store.ingest(page.points, { from, to })
        store.setPhase('ready')
        apply(entry, b)
        if (page.nextFrom === null) return
        from = page.nextFrom
      }
    } catch (err) {
      store.setPhase('error', null, err instanceof Error ? err.message : String(err))
      apply(entry, b)
      console.error(`[plugins] ${b.plugin.id} fetch failed for ${source.id}`, err)
    } finally {
      b.inFlight.delete(tag)
    }
  }

  const ensureCoverage = async (entry: WiredPane, b: Binding): Promise<void> => {
    if (b.disposed) return
    const range = chartRange(entry.chart)
    if (!range) return
    for (const source of b.sources) {
      const window = source.spec.window ? source.spec.window(range) : range
      if (!window) continue
      for (const gap of source.store.missing(window)) await fetchGap(entry, b, source, gap)
    }
    apply(entry, b)
  }

  const storeInUse = (key: string, except: Binding): boolean => {
    for (const e of wired.values()) {
      for (const other of e.bindings.values()) {
        if (other === except || other.disposed) continue
        if (other.sources.some((s) => s.key === key)) return true
      }
    }
    return false
  }

  const dispose = (b: Binding): void => {
    b.disposed = true
    if (b.retryTimer) clearTimeout(b.retryTimer)
    for (const s of b.sources) {
      s.unsubscribe?.()
      s.unsubscribe = null
      if (!storeInUse(s.key, b)) dropStore(s.key)
    }
  }

  const signatureOf = (ind: Indicator, ctx: Omit<BindContext, 'indicator' | 'siblings'>, plugin: IndicatorPlugin): string => {
    const base = [ind.name, ind.paneId, ind.calcParams, ctx.vendor, ctx.ticker, ctx.interval, ctx.paneIndex]
    const extra = plugin.signature ? plugin.signature({ ...ctx, indicator: ind, siblings: [] }) : null
    return JSON.stringify([base, extra ?? null])
  }

  const bind = (entry: WiredPane, plugin: IndicatorPlugin, ind: Indicator, ctx: BindContext, sig: string): Binding | null => {
    let spec: BindingSpec | null
    try {
      spec = plugin.bind(ctx)
    } catch (err) {
      console.error(`[plugins] ${plugin.id} bind failed for ${ind.name}`, err)
      return null
    }
    if (!spec) return null
    const b: Binding = {
      plugin,
      indicatorId: ind.id,
      name: ind.name,
      chartPaneId: ind.paneId,
      signature: sig,
      seq: ++seq,
      spec,
      sources: [],
      state: { sources: [], chartInterval: ctx.interval },
      inFlight: new Set(),
      retryTimer: null,
      disposed: false,
      lastAppliedRev: -1,
      lastShortName: ''
    }
    for (const sourceSpec of spec.sources as SourceSpec[]) {
      const store: SourceStore = storeFor(sourceSpec.key, sourceSpec.createStore ?? ((key) => new WindowStore(key)))
      const bound = { id: sourceSpec.id, key: sourceSpec.key, store, spec: sourceSpec, unsubscribe: null as (() => void) | null }
      b.sources.push(bound)
      b.state.sources.push({ id: bound.id, key: bound.key, store })
    }
    const patch: Record<string, unknown> = { ...(spec.overrides ?? {}) }
    if (Object.keys(patch).length > 0) {
      try {
        entry.chart.overrideIndicator({ id: ind.id, name: ind.name, paneId: ind.paneId, ...patch } as never)
      } catch {
        // ignore
      }
    }
    if (spec.yAxisGap) {
      try {
        entry.chart.overrideYAxis({ paneId: ind.paneId, gap: spec.yAxisGap })
      } catch (err) {
        console.warn(`[plugins] ${plugin.id} y-axis override failed`, err)
      }
    }
    // Subscribed after the store exists and before the first fetch, so a live point that
    // lands during the history read is not lost; the store's key, not the server's, is
    // what the subscription is keyed by.
    for (const s of b.sources) {
      if (!s.spec.subscribe) continue
      try {
        s.unsubscribe = s.spec.subscribe(s.store, {
          changed: () => apply(entry, b),
          refetch: () => void ensureCoverage(entry, b)
        })
      } catch (err) {
        console.error(`[plugins] ${plugin.id} subscribe failed for ${s.id}`, err)
      }
    }
    return b
  }

  const reconcile = (entry: WiredPane): void => {
    let indicators: Indicator[]
    try {
      indicators = entry.chart.getIndicators()
    } catch {
      return
    }
    const symbol = entry.pane.getSymbol()
    const interval = facilities.periodToResolution(entry.pane.getPeriod())
    const vendor = facilities.symbolVendor(symbol)
    const base = { chart: entry.chart, pane: entry.pane, paneIndex: entry.paneIndex, symbol, vendor, ticker: symbol.ticker, interval }
    const seen = new Set<string>()
    const fresh: Binding[] = []
    for (const ind of indicators) {
      const plugin = pluginFor(ind.name)
      if (!plugin) continue
      seen.add(ind.id)
      const sig = signatureOf(ind, base, plugin)
      const existing = entry.bindings.get(ind.id)
      if (existing && existing.signature === sig) continue
      const siblings = [...entry.bindings.values()]
        .filter((o) => o.plugin === plugin && o.indicatorId !== ind.id && !o.disposed)
        .map((o) => ({ indicatorId: o.indicatorId, name: o.name }))
      // The new binding is made BEFORE the old one is disposed, so a store both read
      // (a rebind that keeps a source) survives the hand-over instead of being dropped
      // and refetched.
      const b = bind(entry, plugin, ind, { ...base, indicator: ind, siblings }, sig)
      if (existing) {
        dispose(existing)
        entry.bindings.delete(ind.id)
      }
      if (!b) continue
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

  const wire = (pane: ChartProPane, paneIndex: number): void => {
    const chart = pane.getChart()
    const entry: WiredPane = {
      pane,
      paneIndex,
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

  const validators = plugins.filter((p) => p.validateParams)
  const validateParams =
    validators.length === 0
      ? null
      : async (request: ValidateRequest): Promise<IndicatorParamsCheck> => {
          const plugin = validators.find((p) => p.matches(request.indicatorName))
          return plugin?.validateParams ? plugin.validateParams(request) : { ok: true }
        }

  // Debug hook: what each pane's plugin indicators currently hold -- read-only by
  // convention, never used by the app itself. Replaces the per-plugin __wdIndicators /
  // __wdArev / __wdMtf hooks.
  if (typeof window !== 'undefined') {
    window.__wdPlugins = {
      debug: () =>
        [...wired.values()].flatMap((entry) =>
          [...entry.bindings.values()].map((b) => ({
            pane: entry.pane.id,
            paneIndex: entry.paneIndex,
            plugin: b.plugin.id,
            name: b.name,
            sources: b.sources.map((s) => ({ id: s.id, key: s.key, size: s.store.size, phase: s.store.phase, error: s.store.error }))
          }))
        ),
      paneState: () => host.paneState()
    }
  }

  const host: PluginHost = {
    groups,
    plugins,
    validateParams,
    sync(panes: ChartProPane[]): void {
      const live = new Map(panes.map((p, i) => [p.id, { p, i }]))
      for (const id of [...wired.keys()]) if (!live.has(id)) unwire(id)
      for (const [id, { p, i }] of live) {
        const existing = wired.get(id)
        if (existing && existing.chart === p.getChart()) {
          // A layout change can renumber panes without remounting their charts; the
          // index is part of every binding's signature, so the next reconcile rebinds.
          if (existing.paneIndex !== i) {
            existing.paneIndex = i
            reconcile(existing)
          }
          continue
        }
        if (existing) unwire(id)
        wire(p, i)
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      const plugin = pluginFor(request.indicatorName)
      return plugin?.handleSettings ? plugin.handleSettings(request) : false
    },
    paneState(): Record<string, Record<number, unknown>> {
      const out: Record<string, Record<number, unknown>> = {}
      for (const p of plugins) if (p.paneState) out[p.id] = p.paneState.snapshot()
      return out
    },
    invalidateFrom(from: number): void {
      // The read clock moved (a replay step): values at or after `from` that were not
      // knowable under the old clock may be now. Forget that coverage in every store and
      // re-cover every binding, which refetches exactly the forgotten windows.
      forgetAllAfter(from)
      for (const entry of wired.values()) coverAll(entry)
    },
    teardown(): void {
      host.sync([])
      for (const p of plugins) p.dispose?.()
    }
  }
  return host
}

declare global {
  interface Window {
    __wdPlugins?: { debug: () => unknown[]; paneState: () => unknown }
  }
}
