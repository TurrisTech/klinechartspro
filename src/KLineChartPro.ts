/**
 * Licensed under the Apache License, Version 2.0.
 */

import { mount, unmount } from 'svelte'
import { utils, type Chart, type DeepPartial, type Nullable, type Styles } from 'klinecharts'

import ChartProComponent from './ChartPro.svelte'
import type { ChartPro, ChartProOptions, Period, SymbolInfo } from './types'

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
        datafeed: options.datafeed
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

  getSlot(name: 'toolbar' | 'rail-footer'): Nullable<HTMLElement> {
    return this.component.getSlot(name)
  }

  remove(): void {
    void unmount(this.component)
    this.container.classList.remove('klinecharts-pro', 'dark')
    delete this.container.dataset.theme
  }
}
