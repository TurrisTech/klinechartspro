/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Chart, KLineData, Nullable, Styles, DeepPartial } from 'klinecharts'
import type { LayoutPreset } from './config/layouts'

export interface SymbolInfo {
  ticker: string
  name?: string
  shortName?: string
  exchange?: string
  market?: string
  pricePrecision?: number
  volumePrecision?: number
  priceCurrency?: string
  type?: string
  logo?: string
}

export interface Period {
  multiplier: number
  timespan: string
  text: string
}

export type DatafeedSubscribeCallback = (data: KLineData) => void

export interface Datafeed {
  searchSymbols (search?: string): Promise<SymbolInfo[]>
  /**
   * `direction` hints which end of [from, to] is the anchor a caller cares about landing
   * bars nearest to, for implementations (like the client's WdashboardDatafeed) whose
   * upstream range query can only cheaply guarantee one end exactly. 'older' (the default)
   * anchors on `to` -- ChartPane's normal usage, including a seek reload's own newest edge.
   * 'newer' anchors on `from` -- ChartPane's backward-paging branch, walking a seek-parked
   * pane back up towards the present. Safe to ignore for an implementation that always
   * returns the whole range.
   */
  getHistoryKLineData (symbol: SymbolInfo, period: Period, from: number, to: number, direction?: 'older' | 'newer'): Promise<KLineData[]>
  subscribe (symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void
  unsubscribe (symbol: SymbolInfo, period: Period): void
}

// Builds one Datafeed per wall pane, called lazily on that pane's first mount. Required
// whenever a Datafeed keeps per-subscription state keyed by symbol+interval (as
// WdashboardDatafeed does) -- two panes on the same symbol+interval sharing one instance
// would silently clobber each other's stream listener. A plain `Datafeed` is still accepted
// for back-compat (every pane then shares that one instance), but is only actually safe to
// share when the datafeed itself is stateless.
export type DatafeedFactory = (paneId: string) => Datafeed

// Where one pane was LOOKING when it was last read -- the half of a pane's state that the
// symbol, the period and the indicator list say nothing about, and that a reload would
// otherwise throw away. Every field is what the chart itself reports, so a captured view can
// be handed straight back as a seed.
export interface PaneViewState {
  /** klinecharts' bar space, in px per bar: the TIME axis's zoom. Restored as-is, so a pane
   * comes back at the same magnification whatever it is showing. */
  barSpace: number
  /** Whether the newest bar there is was on screen -- i.e. the pane was following the live
   * candle. Restored by scrolling to the tail as it stands NOW, not to `anchor`: a pane that
   * was watching the market must still be watching it after an hour-long tab close. */
  live: boolean
  /** The instant under `fraction` of the price area's width, and that fraction. Written
   * always, read only when `live` is false -- for a pane parked in (or merely scrolled back
   * into) history, this is the position to come back to. */
  anchor?: number
  fraction?: number
  /** The PRICE axis. `type`/`reverse` are the settings dialog's own two y-axis controls
   * ('normal' | 'percentage' | 'logarithm'), which apply to every chart pane. `range` is the
   * candle pane's manually-scaled range, present only when the user has actually dragged the
   * axis -- an auto-scaled axis has no range worth restoring, and pinning one would stop it
   * following the data. */
  yAxis?: {
    type?: string
    reverse?: boolean
    range?: PaneYAxisRange
  }
}

/** klinecharts' own AxisRange, carried verbatim: a manual scale is an absolute price window,
 * and every derived field (real/display) is a pure function of the axis type it was captured
 * under, so round-tripping the whole record is exact where recomputing two of nine fields
 * would not be. */
export interface PaneYAxisRange {
  from: number
  to: number
  range: number
  realFrom: number
  realTo: number
  realRange: number
  displayFrom: number
  displayTo: number
  displayRange: number
}

// Seed for one wall pane, either at construction (`ChartProOptions.panes`) or read back via
// `PaneSnapshot`. `period` falls back to `ChartProOptions.period` when omitted.
export interface PaneOptions {
  symbol: SymbolInfo
  period?: Period
  mainIndicators?: string[]
  subIndicators?: string[]
  /** Indicator template name -> calcParams, for any indicator on this pane whose parameters
   * were changed from its template default. Applied AT CREATION (klinecharts' own
   * `createIndicator` takes them), so a restored MA(50) is never briefly drawn at MA(5). */
  indicatorParams?: Record<string, unknown[]>
  /** Where this pane was looking. Omitted for a pane that has never been read back -- it then
   * mounts at the live edge, which is what a fresh pane has always done. */
  view?: PaneViewState
}

// A plain-data read of one pane's current construction-relevant state -- what
// `onPaneLayoutChange` hands back for a caller to persist, and what a restored `panes` array
// (from that same persisted shape) looks like.
export interface PaneSnapshot {
  id: string
  symbol: SymbolInfo
  period: Period
  mainIndicators: string[]
  subIndicators: string[]
  /** As PaneOptions.indicatorParams. Only templates that actually carry calcParams appear. */
  indicatorParams: Record<string, unknown[]>
  /** As PaneOptions.view. Null until this pane's chart has mounted and been read once. */
  view: PaneViewState | null
}

// Public per-pane handle returned by getPanes()/getPane(). Only ever handed out for a pane
// whose chart is currently live -- a pane hidden by the active layout preset is absent from
// getPanes() until it is shown again.
export interface ChartProPane {
  readonly id: string
  getChart(): Chart
  getSymbol(): SymbolInfo
  setSymbol(symbol: SymbolInfo): void
  getPeriod(): Period
  setPeriod(period: Period): void
  getDatafeed(): Datafeed
  isActive(): boolean
}

// One extra group of indicator choices for the picker dialog, beyond klinecharts' built-ins:
// an app registers its own indicator templates (klinecharts' registerIndicator) and lists
// them here so they appear beside the built-in ones. `label` is shown as-is (no i18n key --
// the app owns the naming); `main` says whether the group's items go on the candle pane
// (stacked) or each into their own sub-pane. Names must be the registered template names.
export interface IndicatorGroup {
  label: string
  main: boolean
  items: Array<{ name: string; label: string; description?: string }>
}

/** What an app knows about a set of indicator params that the library cannot.
 *
 * The params dialog edits a flat numeric `calcParams` array and knows nothing beyond the
 * template name -- not the instrument, not the datafeed, certainly not whether a server can
 * answer for those numbers. An app that does know supplies this, and the dialog turns the
 * answer into a message and a disabled Confirm instead of letting the user commit params
 * that will fail on the next fetch. */
export interface IndicatorParamsCheck {
  /** False disables Confirm; `reason` then says why. */
  ok: boolean
  /** Human sentence shown when `ok` is false. */
  reason?: string | null
  /** Advisory note shown whether or not `ok` -- a cost, a warm-up, a caveat. */
  hint?: string | null
}

export type IndicatorParamsValidator = (request: {
  indicatorName: string
  calcParams: unknown[]
  symbol: SymbolInfo
  period: Period
}) => Promise<IndicatorParamsCheck>

export interface ChartProOptions {
  container: string | HTMLElement
  styles?: DeepPartial<Styles>
  watermark?: string | Node
  theme?: string
  locale?: string
  drawingBarVisible?: boolean
  symbol: SymbolInfo
  period: Period
  periods?: Period[]
  /** `Period.text` values shown as chips on the top-rail timeframe rail; the rest live
   * behind the dropdown. Construction-time only, like `periods` — change it via
   * `onStarredPeriodsChange`, not by remounting. */
  starredPeriods?: string[]
  /** Fired on every star/unstar so the caller can persist the new set. */
  onStarredPeriodsChange?: (starredPeriods: string[]) => void
  timezone?: string
  mainIndicators?: string[]
  subIndicators?: string[]
  /** Extra indicator groups for the picker dialog (see IndicatorGroup). */
  indicatorGroups?: IndicatorGroup[]
  /** Asked, debounced, whenever the indicator params dialog is open and its numbers change.
   * Omitted, the dialog behaves exactly as before: every params combination is offered. */
  indicatorParamsValidator?: IndicatorParamsValidator | null
  datafeed: Datafeed | DatafeedFactory

  /** Layout preset id (see src/config/layouts.ts). Defaults to '1', a single chart. */
  paneLayout?: string
  /** Per-pane seeds. When omitted, every pane beyond the first (as implied by `paneLayout`)
   * is cloned from `symbol`/`period`/`mainIndicators`/`subIndicators`. */
  panes?: PaneOptions[]
  /** Upper bound on wall size. Default 12. */
  maxPanes?: number
  /** Which pane (by id, 'p1'..'pN') starts active. Defaults to 'p1'; out-of-range ids fall
   * back to the same default. */
  activePane?: string
  /** Initial state of the sync toggles. `syncCrosshair`/`syncTime` default true; `syncAuto`
   * defaults false, and while it is on it SUPERSEDES `syncTime` -- see onSyncChange. */
  syncCrosshair?: boolean
  syncTime?: boolean
  syncAuto?: boolean
  onPaneLayoutChange?: (layoutId: string, panes: PaneSnapshot[]) => void
  onActivePaneChange?: (paneId: string) => void
  /** Fires whenever a pane's own durable state changes without the layout, the symbol or the
   * period changing: an indicator added, removed or re-parameterised, and -- debounced to the
   * end of a gesture -- the time and price axes moving. Carries only the pane id: like every
   * other change callback here, the answer is to re-read `getPaneSnapshots()`, which is now
   * the whole of what a caller needs to persist.
   *
   * Without this a pan, a zoom or an MA(5) -> MA(50) survived only until the next symbol or
   * layout change happened to persist the wall on its behalf. */
  onPaneStateChange?: (paneId: string) => void
  /** Fires whenever the live pane set changes -- a pane's chart was just created or just
   * destroyed. The definitive replacement for polling getChart(); a consumer that needs to
   * wire per-pane behaviour (e.g. price-level overlays) should resync entirely from this
   * callback's argument rather than diffing it itself. */
  onPanesChange?: (panes: ChartProPane[]) => void
  onSymbolChange?: (paneId: string, symbol: SymbolInfo) => void
  onPeriodChange?: (paneId: string, period: Period) => void
  /** Fires whenever any sync toggle changes -- the two in the toolbar's Sync popover, and the
   * auto-sync button beside it. `auto` and `time` are alternatives, not additions: with `auto`
   * on the wall follows every pan, and click-to-scroll is inert whatever `time` says. */
  onSyncChange?: (options: { crosshair: boolean; time: boolean; auto: boolean }) => void
}

export interface ChartPro {
  /**
   * The ACTIVE pane's underlying KLineChart instance, or null before the component has
   * mounted. For a specific pane regardless of which is active, use getPane(id).getChart().
   *
   * The escape hatch for anything this wrapper does not model itself — overlays,
   * indicators registered at runtime, direct style overrides. Callers own what they add and
   * should scope it (e.g. an overlay `groupId`) so it can be removed again without
   * disturbing chart state this component manages.
   */
  getChart(): Nullable<Chart>
  setTheme(theme: string): void
  getTheme(): string
  /** Construction-time-global style option setter: fans out to every pane. For the active
   * pane's own styles, see getPane(id) / the settings dialog. */
  setStyles(styles: DeepPartial<Styles>): void
  /** The ACTIVE pane's styles. */
  getStyles(): Styles
  setLocale(locale: string): void
  getLocale(): string
  setTimezone(timezone: string): void
  getTimezone(): string
  /** The ACTIVE pane's symbol/period. For a specific pane, use getPane(id). */
  setSymbol(symbol: SymbolInfo): void
  getSymbol(): SymbolInfo
  setPeriod(period: Period): void
  getPeriod(): Period
  /**
   * An empty anchor element inside the chart shell that a consuming app can mount its own
   * controls into — the top-rail toolbar (after the timeframe rail) or the bottom of the
   * left drawing rail. Returns null before mount, and null for 'rail-footer' whenever the
   * drawing rail is hidden (drawingBarVisible: false), since that footer lives inside it.
   */
  getSlot(name: 'toolbar' | 'rail-footer'): Nullable<HTMLElement>

  /** Every currently-live pane (i.e. shown by the active layout preset), in pane order. */
  getPanes(): ChartProPane[]
  /** Plain-data snapshot of every currently-live pane -- symbol, period AND indicators
   * (`ChartProPane` deliberately omits the latter; use this when persisting the whole wall,
   * e.g. alongside onPaneLayoutChange/onActivePaneChange). */
  getPaneSnapshots(): PaneSnapshot[]
  /** A specific pane by id, or null if it isn't currently live. */
  getPane(id: string): ChartProPane | null
  getActivePaneId(): string
  setActivePane(id: string): void
  setPaneLayout(id: string): void
  getPaneLayout(): string
  getPaneLayouts(): LayoutPreset[]
}
