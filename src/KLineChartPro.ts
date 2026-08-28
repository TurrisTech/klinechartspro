/**
 * Licensed under the Apache License, Version 2.0.
 */

import { mount, unmount } from 'svelte'
import { utils, type Chart, type DeepPartial, type Nullable, type Styles } from 'klinecharts'

import ChartProComponent from './ChartPro.svelte'
import { MAX_PANES, smallestLayoutFor } from './config/layouts'
import type { LayoutPreset } from './config/layouts'
import type {
  ChartPro,
  ChartProOptions,
  ChartProPane,
  ChartProSlot,
  Period,
  SymbolInfo
} from './types'

const DEFAULT_PERIODS: Period[] = [
  { multiplier: 1, timespan: 'minute', text: '1m' },
  { multiplier: 5, timespan: 'minute', text: '5m' },
  { multiplier: 15, timespan: 'minute', text: '15m' },
  { multiplier: 1, timespan: 'hour', text: '1H' },
  { multiplier: 2, timespan: 'hour', text: '2H' },
  { multiplier: 4, timespan: 'hour', text: '4H' },
  { multiplier: 1, timespan: 'day', text: 'D' },
  { multiplier: 1, timespan: 'week', text: 'W' },
  { multiplier: 1, timespan: 'month', text: 'M' },
  { multiplier: 1, timespan: 'year', text: 'Y' }
]

const DEFAULT_WATERMARK = `
  <div class="klinecharts-pro-brand-mark" aria-hidden="true">
    <strong>KLINE</strong><span>CHART PRO</span>
  </div>
`

export default class KLineChartPro implements ChartPro {
  private readonly container: HTMLElement
  private readonly component: ChartPro

  constructor(options: ChartProOptions) {
    if (utils.isString(options.container)) {
      const container = document.getElementById(options.container as string)
      if (!container) throw new Error('Container is null')
      this.container = container
    } else {
      this.container = options.container as HTMLElement
    }

    const theme = options.theme ?? 'light'
    this.container.classList.add('klinecharts-pro')
    this.container.classList.toggle('dark', theme === 'dark')
    this.container.dataset.theme = theme

    // The one place the "panes given but no explicit layout" ambiguity is resolved: below
    // this point `paneLayout` is always a concrete preset id, so ChartPro.svelte never has to
    // ask "did the caller mean it, or is this just the default?".
    const paneLayout = options.paneLayout
      ?? (options.panes ? smallestLayoutFor(options.panes.length).id : '1')

    this.component = mount(ChartProComponent, {
      target: this.container,
      props: {
        styles: options.styles ?? {},
        watermark: options.watermark ?? DEFAULT_WATERMARK,
        theme,
        locale: options.locale ?? 'zh-CN',
        drawingBarVisible: options.drawingBarVisible ?? true,
        symbol: options.symbol,
        period: options.period,
        periods: options.periods ?? DEFAULT_PERIODS,
        starredPeriods: options.starredPeriods ?? [],
        onStarredPeriodsChange: options.onStarredPeriodsChange ?? (() => {}),
        timezone: options.timezone ?? 'Asia/Shanghai',
        mainIndicators: options.mainIndicators ?? ['MA'],
        subIndicators: options.subIndicators ?? ['VOL'],
        indicatorGroups: options.indicatorGroups ?? [],
        // Null, not a no-op that answers ok: the dialog distinguishes "nobody is checking"
        // from "checked and fine", and only the first leaves the UI exactly as it was.
        indicatorParamsValidator: options.indicatorParamsValidator ?? null,
        indicatorSettingsHandler: options.indicatorSettingsHandler ?? null,
        datafeed: options.datafeed,
        paneLayout,
        panes: options.panes ?? [],
        maxPanes: options.maxPanes ?? MAX_PANES,
        activePane: options.activePane ?? 'p1',
        syncCrosshair: options.syncCrosshair ?? true,
        syncTime: options.syncTime ?? true,
        syncAuto: options.syncAuto ?? false,
        onPaneLayoutChange: options.onPaneLayoutChange ?? (() => {}),
        onActivePaneChange: options.onActivePaneChange ?? (() => {}),
        onPaneStateChange: options.onPaneStateChange ?? (() => {}),
        onPanesChange: options.onPanesChange ?? (() => {}),
        onSymbolChange: options.onSymbolChange ?? (() => {}),
        onPeriodChange: options.onPeriodChange ?? (() => {}),
        onSyncChange: options.onSyncChange ?? (() => {})
      }
    }) as ChartPro
  }

  getChart(): Nullable<Chart> {
    return this.component.getChart()
  }

  setTheme(theme: string): void {
    this.container.dataset.theme = theme
    this.container.classList.toggle('dark', theme === 'dark')
    this.component.setTheme(theme)
  }

  getTheme(): string {
    return this.component.getTheme()
  }

  setStyles(styles: DeepPartial<Styles>): void {
    this.component.setStyles(styles)
  }

  getStyles(): Styles {
    return this.component.getStyles()
  }

  setLocale(locale: string): void {
    this.component.setLocale(locale)
  }

  getLocale(): string {
    return this.component.getLocale()
  }

  setTimezone(timezone: string): void {
    this.component.setTimezone(timezone)
  }

  getTimezone(): string {
    return this.component.getTimezone()
  }

  setSymbol(symbol: SymbolInfo): void {
    this.component.setSymbol(symbol)
  }

  getSymbol(): SymbolInfo {
    return this.component.getSymbol()
  }

  setPeriod(period: Period): void {
    this.component.setPeriod(period)
  }

  getPeriod(): Period {
    return this.component.getPeriod()
  }

  getSlot(name: ChartProSlot): Nullable<HTMLElement> {
    return this.component.getSlot(name)
  }

  /** The element this chart was constructed with. Unlike getSlot(), it is valid from the
   * moment the constructor returns — the slots inside it are `bind:this` targets and read
   * null until Svelte flushes the mount effect — so it is what anything watching the chart's
   * own DOM for changes has to observe. */
  getContainer(): HTMLElement {
    return this.container
  }

  getPanes(): ChartProPane[] {
    return this.component.getPanes()
  }

  getPaneSnapshots() {
    return this.component.getPaneSnapshots()
  }

  getPane(id: string): ChartProPane | null {
    return this.component.getPane(id)
  }

  getActivePaneId(): string {
    return this.component.getActivePaneId()
  }

  setActivePane(id: string): void {
    this.component.setActivePane(id)
  }

  setPaneLayout(id: string): void {
    this.component.setPaneLayout(id)
  }

  getPaneLayout(): string {
    return this.component.getPaneLayout()
  }

  getPaneLayouts(): LayoutPreset[] {
    return this.component.getPaneLayouts()
  }

  remove(): void {
    void unmount(this.component)
    this.container.classList.remove('klinecharts-pro', 'dark')
    delete this.container.dataset.theme
  }
}
