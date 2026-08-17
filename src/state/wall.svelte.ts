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

import type { Chart, DeepPartial, OverlayCreate, OverlayMode, Styles } from 'klinecharts'

import { getLayouts, layoutById, type LayoutPreset } from '../config/layouts'
import type {
  DatafeedFactory,
  Datafeed,
  PaneOptions,
  PaneSnapshot,
  Period,
  SymbolInfo
} from '../types'

// The per-pane imperative surface a mounted ChartPane publishes into its own PaneState.api
// once its klinecharts instance exists. The shell (ChartPro.svelte) drives the active pane
// entirely through this handle rather than reaching into ChartPane internals.
export interface PaneApi {
  chart: Chart
  // No resize() -- klinecharts installs its own ResizeObserver on the container passed to
  // init() and resizes itself whenever that element's size changes (window resize, a CSS
  // Grid layout change, the drawing rail toggling, fullscreen).
  changeIndicator(name: string, main: boolean, added: boolean): void
  applyYAxisSettings(chartPaneId?: string): void
  getStyles(): Styles
  setStyles(patch: DeepPartial<Styles>): void
  // Single-key style write for the settings dialog -- 'yAxis.type'/'yAxis.reverse' are
  // handled specially (they drive overrideYAxis via applyYAxisSettings and PaneState's own
  // yAxisType/yAxisReverse fields, not chart.setStyles), everything else is a dotted path
  // into Styles applied via chart.setStyles. Returns a fresh snapshot so the shell's
  // settings-dialog display (its own `settingsStyles` copy) can be updated without the shell
  // needing its own clone/setByPath bookkeeping of the chart's internal style tree.
  setStyleValue(key: string, value: unknown): Styles
  restoreStyles(): Styles
  createOverlay(name: string, drawing: { mode: OverlayMode; lock: boolean; visible: boolean }): void
  overrideOverlay(patch: Partial<OverlayCreate>): void
  removeDrawings(): void
  screenshot(background: string): string
}

function cloneOptions(options?: PaneOptions | null): {
  symbol: SymbolInfo
  period: Period | undefined
  mainIndicators: string[]
  subIndicators: string[]
} {
  return {
    symbol: options?.symbol as SymbolInfo,
    period: options?.period,
    mainIndicators: options?.mainIndicators ? [...options.mainIndicators] : [],
    subIndicators: options?.subIndicators ? [...options.subIndicators] : []
  }
}

// One wall pane's durable state -- everything that must survive a layout shrink (the chart
// itself does not: ChartPane unmounts and re-mounts against this record). `symbol`, `period`,
// `mainIndicators` and `subIndicatorNames` are $state.raw, never deep $state: they are always
// replaced wholesale (never mutated in place), and a deep proxy here would leak into
// klinecharts and into the datafeed, which both expect plain objects.
export class PaneState {
  readonly id: string
  symbol = $state.raw<SymbolInfo>(undefined as unknown as SymbolInfo)
  period = $state.raw<Period>(undefined as unknown as Period)
  mainIndicators = $state.raw<string[]>([])
  // Durable list of sub-indicator NAMES only. The name -> chartPaneId map klinecharts needs
  // is transient (meaningless once the chart is disposed) and lives as local $state inside
  // ChartPane, not here.
  subIndicatorNames = $state.raw<string[]>([])
  yAxisType = $state('normal')
  yAxisReverse = $state(false)
  loading = $state(false)
  // The live imperative handle, or null before/after the chart exists. $state.raw: a Chart
  // instance (canvases, internal stores, event handlers) must never be deep-proxied.
  api = $state.raw<PaneApi | null>(null)

  private readonly datafeedFactory: DatafeedFactory
  private _datafeed: Datafeed | null = null

  constructor(id: string, datafeedFactory: DatafeedFactory, seed?: PaneOptions | null) {
    this.id = id
    this.datafeedFactory = datafeedFactory
    const resolved = cloneOptions(seed)
    this.symbol = resolved.symbol
    if (resolved.period) this.period = resolved.period
    this.mainIndicators = resolved.mainIndicators
    this.subIndicatorNames = resolved.subIndicators
  }

  // Constructed lazily on first access (i.e. this pane's first mount), not eagerly for all
  // maxPanes slots -- a wall parked on the '1' layout should not open 11 idle datafeeds.
  get datafeed(): Datafeed {
    if (!this._datafeed) this._datafeed = this.datafeedFactory(this.id)
    return this._datafeed
  }

  seed(options: PaneOptions): void {
    this.symbol = options.symbol
    if (options.period) this.period = options.period
    this.mainIndicators = options.mainIndicators ? [...options.mainIndicators] : []
    this.subIndicatorNames = options.subIndicators ? [...options.subIndicators] : []
  }

  snapshot(): PaneSnapshot {
    return {
      id: this.id,
      symbol: this.symbol,
      period: this.period,
      mainIndicators: [...this.mainIndicators],
      subIndicators: [...this.subIndicatorNames]
    }
  }
}

export interface WallOptions {
  maxPanes: number
  initialLayoutId: string
  initialActiveId: string
  datafeedFactory: DatafeedFactory
  /** Seeds in pane order (index 0 -> 'p1', ...). Missing trailing entries clone the last
   * given seed, so a caller can supply just the first pane and still fill an N-pane preset. */
  seeds: PaneOptions[]
  onPaneLayoutChange?: (layoutId: string, panes: PaneSnapshot[]) => void
  onActivePaneChange?: (paneId: string) => void
}

// The reactive model backing the whole wall: which panes exist, which layout preset is
// active, and which pane is the active one the toolbar acts on. Instantiated inside
// ChartPro.svelte's <script> body -- NEVER at module scope, which would leak rune state
// across two `new KLineChartPro()` instances mounted on the same page.
export class Wall {
  layoutId = $state('1')
  activeId = $state('p1')
  readonly panes: PaneState[]

  private readonly onPaneLayoutChangeCb?: (layoutId: string, panes: PaneSnapshot[]) => void
  private readonly onActivePaneChangeCb?: (paneId: string) => void

  constructor(options: WallOptions) {
    const seeds = options.seeds.length > 0 ? options.seeds : []
    this.panes = Array.from({ length: options.maxPanes }, (_, index) => {
      const seed = seeds[index] ?? seeds[seeds.length - 1] ?? null
      return new PaneState(`p${index + 1}`, options.datafeedFactory, seed)
    })
    this.layoutId = layoutById(options.initialLayoutId).id
    // Out-of-range (an id beyond this layout's paneCount, or one that never existed) falls
    // back to the default 'p1' rather than leaving `active` pointed at nothing.
    this.activeId = this.panes
      .slice(0, this.layout.paneCount)
      .some((pane) => pane.id === options.initialActiveId)
      ? options.initialActiveId
      : 'p1'
    this.onPaneLayoutChangeCb = options.onPaneLayoutChange
    this.onActivePaneChangeCb = options.onActivePaneChange
  }

  get layout(): LayoutPreset {
    return layoutById(this.layoutId)
  }

  get layouts(): readonly LayoutPreset[] {
    return getLayouts()
  }

  get visiblePanes(): PaneState[] {
    return this.panes.slice(0, this.layout.paneCount)
  }

  // Always a real pane -- `activeId` is clamped into range on every layout change (see
  // setLayout below), so the `.find` miss this falls back on should be unreachable in
  // practice. Every call site in the shell treats `wall.active` as non-optional.
  get active(): PaneState {
    return this.panes.find((pane) => pane.id === this.activeId) ?? this.panes[0]
  }

  setLayout(id: string): void {
    const next = layoutById(id)
    if (next.id === this.layoutId) return
    this.layoutId = next.id
    // Clamp the active pane into the newly-visible range rather than leaving it pointed at a
    // pane the grid no longer renders.
    const stillVisible = this.panes.slice(0, next.paneCount).some((p) => p.id === this.activeId)
    if (!stillVisible) this.activate(this.panes[next.paneCount - 1].id)
    this.onPaneLayoutChangeCb?.(this.layoutId, this.visiblePanes.map((p) => p.snapshot()))
  }

  activate(id: string): void {
    if (id === this.activeId) return
    if (!this.visiblePanes.some((p) => p.id === id)) return
    this.activeId = id
    this.onActivePaneChangeCb?.(id)
  }
}
