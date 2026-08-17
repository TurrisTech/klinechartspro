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
  getHistoryKLineData (symbol: SymbolInfo, period: Period, from: number, to: number): Promise<KLineData[]>
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

// Seed for one wall pane, either at construction (`ChartProOptions.panes`) or read back via
// `PaneSnapshot`. `period` falls back to `ChartProOptions.period` when omitted.
export interface PaneOptions {
  symbol: SymbolInfo
  period?: Period
  mainIndicators?: string[]
  subIndicators?: string[]
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
  /** Initial state of the two sync toggles; both default true. */
  syncCrosshair?: boolean
  syncTime?: boolean
  onPaneLayoutChange?: (layoutId: string, panes: PaneSnapshot[]) => void
  onActivePaneChange?: (paneId: string) => void
  /** Fires whenever the live pane set changes -- a pane's chart was just created or just
   * destroyed. The definitive replacement for polling getChart(); a consumer that needs to
   * wire per-pane behaviour (e.g. price-level overlays) should resync entirely from this
   * callback's argument rather than diffing it itself. */
  onPanesChange?: (panes: ChartProPane[]) => void
  onSymbolChange?: (paneId: string, symbol: SymbolInfo) => void
  onPeriodChange?: (paneId: string, period: Period) => void
  /** Fires whenever either sync toggle (the toolbar's Sync popover) changes. */
  onSyncChange?: (options: { crosshair: boolean; time: boolean }) => void
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
