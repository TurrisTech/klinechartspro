import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane, Period, SymbolInfo } from '../../src'

// Test doubles for the plugin host: a DOM stub for modules that read `window` at import,
// and a fake chart/pane pair that records what the host does to it. Not shipped: nothing
// outside `*.test.ts` imports this.

export function installWindow(): void {
  const g = globalThis as { window?: unknown }
  if (g.window) return
  // `navigator` because klinecharts sniffs the platform at import (a template module
  // pulls it in); nothing here renders.
  g.window = { location: { origin: 'http://test', href: 'http://test/' }, navigator: { userAgent: 'test' } }
}

export interface FakeChart {
  chart: Chart
  indicators: Indicator[]
  data: Array<{ timestamp: number }>
  overrides: Array<Record<string, unknown>>
  yAxisOverrides: Array<Record<string, unknown>>
  actions: Map<string, Set<() => void>>
  fireRange(): void
}

export function fakeChart(): FakeChart {
  const state: FakeChart = {
    indicators: [],
    data: [],
    overrides: [],
    yAxisOverrides: [],
    actions: new Map(),
    chart: null as unknown as Chart,
    fireRange() {
      for (const fn of state.actions.get('onVisibleRangeChange') ?? []) fn()
    }
  }
  state.chart = {
    getIndicators: () => state.indicators,
    getDataList: () => state.data,
    overrideIndicator: (patch: Record<string, unknown>) => {
      state.overrides.push(patch)
      return true
    },
    overrideYAxis: (patch: Record<string, unknown>) => {
      state.yAxisOverrides.push(patch)
    },
    subscribeAction: (type: string, fn: () => void) => {
      let set = state.actions.get(type)
      if (!set) {
        set = new Set()
        state.actions.set(type, set)
      }
      set.add(fn)
    },
    unsubscribeAction: (type: string, fn: () => void) => {
      state.actions.get(type)?.delete(fn)
    }
  } as unknown as Chart
  return state
}

export function fakeIndicator(name: string, id: string, calcParams: unknown[] = [], paneId = 'candle_pane'): Indicator {
  return { id, name, paneId, calcParams, result: [], extendData: undefined } as unknown as Indicator
}

export function fakePane(id: string, chart: Chart, ticker = 'EURUSD', period: Period = { multiplier: 1, timespan: 'hour', text: '1h' }): ChartProPane {
  const symbol = { ticker, exchange: 'oanda', pricePrecision: 5 } as unknown as SymbolInfo
  return {
    id,
    getChart: () => chart,
    getSymbol: () => symbol,
    setSymbol: () => {},
    getPeriod: () => period,
    setPeriod: () => {},
    getDatafeed: () => null as never,
    isActive: () => false
  }
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
