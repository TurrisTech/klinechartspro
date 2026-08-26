import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane, IndicatorGroup, IndicatorParamsCheck, Period, SymbolInfo } from '../../src'
import type { Feature } from '../capabilities'
import type { SettingsPanelHandle, SettingsPanelOptions } from '../chartlayers/settings'
import type { stream } from '../stream'

// The client half of the indicator plugin model.
//
// An indicator on the chart that reads data the server holds -- a registry series, an AREV
// generation, krev's votes, the AREV21 multi-timeframe overlay -- is an `IndicatorPlugin`.
// The plugin declares its klinecharts templates and how one instance on one pane maps to
// SOURCES (a series to fetch, keyed so panes showing the same one share it); the host
// (`host.ts`) owns everything that used to be copied per plugin: watching each pane's
// indicator list, fetching exactly the windows a store is missing (paged), keeping a store
// per source alive for as long as some pane reads it, subscribing live updates, and handing
// the chart the values by bumping the indicator's extendData. A plugin never touches the
// chart's data path; it reads its stores back from `calc` (`peekStore`).
//
// The server has the same shape (`wdashboard_server/plugins`): a plugin there reads points,
// the host owns the route. The two meet on `GET /plugins/{id}/values` (`api.ts`).

export interface Range {
  from: number
  to: number
}

export type Phase = 'idle' | 'loading' | 'queued' | 'replaying' | 'ready' | 'error'

/** One page of a fetch. `nextFrom` says where the next page starts, or `null` when the
 * requested range is covered -- so a capped answer (`points.length >= limit`) continues
 * from the last point, and a chunked fetch continues from the chunk's end, through one
 * host loop. `status` reports a server still building the series; the host records the
 * phase and retries after `retryAfterMs`. */
export interface Page<P> {
  points: P[]
  nextFrom: number | null
  status?: { phase: 'queued' | 'replaying'; progress: number | null; retryAfterMs: number }
  /** The auxiliary arrays named in the request, by name. Absent when none were asked for;
   * a name the server did not send reads as an empty array, so a plugin talking to an
   * older server sees "no trades" rather than a crash. Paging is driven by `points`
   * alone: an auxiliary array is a different kind of row and does not have its own
   * cursor. */
  arrays?: Record<string, { date: number }[]>
}

/** What the host needs from a store. `WindowStore` (store.ts) is the implementation
 * every plugin uses unless it holds something beside points (mtf's bar grid). */
export interface SourceStore<P = unknown> {
  readonly key: string
  /** Bumped on every change; the template's shouldUpdate compares it. */
  rev: number
  phase: Phase
  progress: number | null
  error: string | null
  size: number
  /** `arrays` carries the auxiliary arrays the source asked for, by name -- a store
   * that reads only points ignores the third argument, which is why it is optional and
   * why every existing store is unchanged. */
  ingest(points: P[], window: Range, arrays?: Record<string, { date: number }[]>): void
  /** The parts of `window` not yet fetched. */
  missing(window: Range): Range[]
  /** Forget coverage at or after `from` (the replay's cursor moved: values that were not
   * knowable then may be now). Optional; a store without it is refetched whole. */
  forgetAfter?(from: number): void
  setPhase(phase: Phase, progress?: number | null, error?: string | null): void
}

export interface SourceNotify {
  /** The store changed: re-apply to the chart. */
  changed(): void
  /** The store may be short: cover the chart's range again. */
  refetch(): void
}

/** One series a binding reads. Bindings on any pane whose sources share a `key` share
 * one store, dropped with the last of them. */
export interface SourceSpec<P = unknown> {
  /** The name under which this source appears in `extendData.seriesKeys`. */
  id: string
  /** Store identity across the wall. Everything that decides the data, nothing else. */
  key: string
  fetch(range: Range, limit: number): Promise<Page<P>>
  /** The window to cover, from the range of bars the chart holds. Defaults to it. */
  window?(chartRange: Range): Range | null
  /** A custom store (must accept what `fetch` yields). Defaults to a `WindowStore`. */
  createStore?(key: string): SourceStore<P>
  /** Live updates. Returns the disposer. */
  subscribe?(store: SourceStore<P>, notify: SourceNotify): () => void
}

export interface BoundSource {
  id: string
  key: string
  store: SourceStore
}

export interface BindingState {
  sources: BoundSource[]
  chartInterval: string
}

/** What a plugin returns for one indicator instance on one pane. */
export interface BindingSpec {
  sources: SourceSpec<never>[] | SourceSpec[]
  /** The legend text (klinecharts appends `(calcParams)` itself). */
  label(state: BindingState): string
  /** Merged into extendData beside the host's `seriesKey`, `seriesKeys` and `rev`. */
  extendData?(state: BindingState): Record<string, unknown>
  /** One-off overrideIndicator patch applied when the binding is made (precision, styles). */
  overrides?: Record<string, unknown>
  /** The pane's y-axis padding, for a sub-pane whose range is bounded by its own lines. */
  yAxisGap?: { top: number; bottom: number }
}

export interface BindContext {
  chart: Chart
  pane: ChartProPane
  /** Position in the wall -- what per-pane document state is keyed by. */
  paneIndex: number
  indicator: Indicator
  symbol: SymbolInfo
  vendor: string
  ticker: string
  /** The chart's interval code ('1h', '1D'). */
  interval: string
  /** This plugin's other bindings on the pane, in order of appearance. */
  siblings: Array<{ indicatorId: string; name: string }>
}

export interface PaneInfo {
  chart: Chart
  pane: ChartProPane
  paneIndex: number
}

export interface SettingsRequest {
  indicatorName: string
  paneId: string
  chartPaneId: string
  calcParams: unknown[]
}

export interface ValidateRequest {
  indicatorName: string
  calcParams: unknown[]
  symbol: SymbolInfo
  period: Period
}

/** The stream surface a plugin may use: the page's live `StreamClient`, or an inert one on
 * a replay wall (nothing live may reach a replay's stores). */
export type PluginStream = Pick<typeof stream, 'subscribe' | 'unsubscribe' | 'subscribeIndicator' | 'unsubscribeIndicator' | 'onStatus'>

/** What the client gives every plugin: the app's shared services, generalised. */
export interface PluginFacilities {
  api: {
    get<T>(path: string, params?: Record<string, string | number | null | undefined>): Promise<T>
    url(path: string, params?: Record<string, string | number | null | undefined>): URL
  }
  stream: PluginStream
  hasFeature(feature: Feature): boolean
  /** The unified server wire: `GET /plugins/{id}/values`, or the plugin's legacy path on a
   * server without the plugin host. */
  points<P extends { date: number }>(request: PointsRequest): Promise<Page<P>>
  periodToResolution(period: Period): string
  resolutionDurationMs(code: string): number
  symbolVendor(symbol: SymbolInfo): string
  openSettingsPanel<T extends object>(options: SettingsPanelOptions<T>): SettingsPanelHandle
  /** Live pane by wall pane id, or null once it is gone. */
  paneInfo(paneId: string): PaneInfo | null
  /** Re-run reconciliation (a settings edit changed what a binding reads). */
  requestReconcile(paneId?: string): void
  /** Ask the app to save the wall document. */
  requestPersist(): void
  /** The server's per-request values cap. */
  maxValuesPerRequest: number
  /** Published signals: what every mounted plugin labels, and one plugin's labelled
   * points -- how a plugin (or a script) consumes another's signals without re-deriving
   * them. Empty / `no_data` on a server without the `plugins.signals` feature. */
  signals: {
    catalogue(): Promise<SignalCatalogueEntry[]>
    points<P extends { date: number }>(request: SignalsRequest): Promise<Page<SignalPoint<P>>>
  }
}

/** One label a plugin publishes (the server's `signal()` row). `id` is what a point's
 * `signal` field carries; `side` is which way it argues, or null for an undirected event. */
export interface SignalSpec {
  id: string
  label: string
  side: 'long' | 'short' | null
  description: string
}

/** One row of `GET /plugins/signals`: a label under its plugin and variant, with the
 * `ref` (`plugin:variant:id`, e.g. `arev:arev21:long`) a consumer names it by. */
export interface SignalCatalogueEntry extends SignalSpec {
  plugin: string
  title: string
  variant: string | null
  available: boolean
  ref: string
}

/** A point the server labelled, as `GET /plugins/{id}/signals` serves it: the plugin's
 * point with its label id and the ABSOLUTE instant (epoch ms, not a wire date) at which
 * the signal became knowable -- its bar's close. Any multi-timeframe consumer keys off
 * `effective`, never off `date` (CLAUDE.md, "Effective timestamps"). */
export type SignalPoint<P = Record<string, unknown>> = P & { date: number; signal: string; effective: number }

export interface SignalsRequest {
  /** A `SignalCatalogueEntry.ref`; an empty id (`arev:arev21:`) is every label. */
  ref: string
  vendorSymbol: string
  resolution: string
  from: number
  to: number
  limit: number
  params?: Record<string, unknown>
  /** The read clock for this request; `null` reads past it on purpose (the replay's own
   * signal look-ahead). Absent: the page-wide clock (config.ts) applies. */
  asof?: number | null
}

export interface PointsRequest {
  pluginId: string
  /** The path a server without `plugins` serves the same thing on. */
  legacyPath?: string
  vendorSymbol: string
  resolution: string
  from: number
  to: number
  limit: number
  variant?: string
  params?: Record<string, unknown>
  /** The legacy path's query, when it differs from the unified one. */
  legacyQuery?: Record<string, string | number | undefined>
  /** Auxiliary arrays to read out of the response beside `points`, by the names the
   * plugin declares in its catalogue entry (`arrays`). A plugin whose read produces a
   * second KIND of row -- mtf01's trades beside its cascade events -- names them here and
   * reads them back off `Page.arrays`. Omitted: the single-array wire. */
  arrays?: readonly string[]
}

export interface IndicatorPlugin {
  id: string
  /** The capability that gates it; `null` for a plugin that is always on. */
  feature: Feature | null
  /** Register klinecharts templates and return the picker groups. Called once per mount,
   * only when `feature` is advertised. */
  register(facilities: PluginFacilities): Promise<IndicatorGroup[]> | IndicatorGroup[]
  matches(templateName: string): boolean
  /** Extra identity of a binding beyond (template, pane, calcParams, instrument, interval):
   * a per-pane settings revision, say. A change rebinds. */
  signature?(ctx: BindContext): unknown
  bind(ctx: BindContext): BindingSpec | null
  /** Claim the gear on one of this plugin's indicators (ChartProOptions.indicatorSettingsHandler). */
  handleSettings?(request: SettingsRequest): boolean
  /** Answer the params dialog (ChartProOptions.indicatorParamsValidator). */
  validateParams?(request: ValidateRequest): Promise<IndicatorParamsCheck>
  /** Per-pane document state, keyed by pane index -- what the wall document persists. */
  paneState?: {
    hydrate(initial: Record<number, unknown>): void
    snapshot(): Record<number, unknown>
  }
  /** The wall is being torn down. */
  dispose?(): void
}
