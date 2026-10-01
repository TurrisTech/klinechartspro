import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { createVolumeProfilePlugin } = await import('./plugin')
import type { SymbolInfo } from '../../src'
import type { BindContext, BindingState, PluginFacilities } from '../plugins/types'

// The binding: which source a pane reads, and what the legend says about it.

const SYMBOL = {
  ticker: 'EURUSD',
  pricePrecision: 5,
  timezone: 'America/New_York',
  dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false }
} as unknown as SymbolInfo

const OANDA = ['5s', '1m', '1h', '1D', '1M']

function setup(data: Array<{ timestamp: number; volume?: number }> = []) {
  const plugin = createVolumeProfilePlugin(() => OANDA)
  plugin.register({ stream: {} } as unknown as PluginFacilities)
  const ctx = (interval: string, symbol: SymbolInfo = SYMBOL, vendor = 'oanda'): BindContext =>
    ({
      chart: { getDataList: () => data },
      pane: { id: 'p1' },
      paneIndex: 0,
      indicator: { id: 'i1', name: 'VP:volume', calcParams: [] },
      symbol,
      vendor,
      ticker: 'EURUSD',
      interval,
      siblings: []
    }) as unknown as BindContext
  return { plugin, ctx }
}

const state = (store: Record<string, unknown> | null): BindingState =>
  ({ sources: store === null ? [] : [{ id: 'bars', key: 'k', store }], chartInterval: '1h' }) as unknown as BindingState

describe('the binding', () => {
  test('only its own template', () => {
    const { plugin } = setup()
    expect(plugin.matches('VP:volume')).toBe(true)
    expect(plugin.matches('VOL')).toBe(false)
  })

  test('an hourly pane reads 1m bars, keyed so every pane on that source shares one store', () => {
    const { plugin, ctx } = setup()
    const spec = plugin.bind(ctx('1h'))
    expect(spec?.sources.map((s) => [s.key, s.resolution])).toEqual([['vp-bars|oanda:EURUSD|1m', '1m']])
    expect(spec?.extendData?.(state(null))).toMatchObject({ source: '1m', chartShift: 0, quantumKey: 'vp-bars|oanda:EURUSD|1m' })
  })

  test('a daily pane reads 1h bars and maps them through the forex wire shift', () => {
    const { plugin, ctx } = setup()
    const spec = plugin.bind(ctx('1D'))
    expect(spec?.sources.map((s) => s.key)).toEqual(['vp-bars|oanda:EURUSD|1h'])
    expect(spec?.extendData?.(state(null))).toMatchObject({ chartShift: 7 * 3_600_000, sourceShift: 0 })
  })

  test('a daily pane with no schedule reads nothing, and says why', () => {
    const { plugin, ctx } = setup()
    const spec = plugin.bind(ctx('1D', { ...SYMBOL, dayGeometry: undefined } as SymbolInfo))
    expect(spec?.sources).toHaveLength(0)
    expect(spec?.label(state(null))).toBe('VP · no schedule for this instrument')
  })

  test('a 1m pane profiles its own bars', () => {
    const { plugin, ctx } = setup()
    const spec = plugin.bind(ctx('1m'))
    expect(spec?.sources).toHaveLength(0)
    expect(spec?.label(state(null))).toBe('VP 1m · tick count')
  })
})

describe('the legend', () => {
  const D = 86_400_000
  test('names the source, and what OANDA volume is', () => {
    const { plugin, ctx } = setup([{ timestamp: 10 * D, volume: 5 }])
    const spec = plugin.bind(ctx('1h'))
    expect(spec?.label(state({ phase: 'idle', bars: [] }))).toBe('VP 1m · loading')
    expect(spec?.label(state({ phase: 'ready', bars: [{ date: 10 * D }] }))).toBe('VP 1m · tick count')
    expect(spec?.label(state({ phase: 'error', bars: [] }))).toBe('VP 1m · unavailable')
  })

  test('says from when the source runs when it does not reach the first chart bar', () => {
    const { plugin, ctx } = setup([{ timestamp: Date.UTC(2026, 0, 5), volume: 5 }])
    const spec = plugin.bind(ctx('1h'))
    expect(spec?.label(state({ phase: 'ready', bars: [{ date: Date.UTC(2026, 7, 13) }] }))).toBe('VP 1m from 2026-08-13 · tick count')
  })

  test('traded volume is just volume; an instrument with none says so', () => {
    const traded = setup([{ timestamp: 0, volume: 5 }])
    expect(traded.plugin.bind(traded.ctx('1m', SYMBOL, 'coinbase'))?.label(state(null))).toBe('VP 1m · volume')
    const none = setup([{ timestamp: 0, volume: 0 }])
    expect(none.plugin.bind(none.ctx('1m', SYMBOL, 'schwab'))?.label(state(null))).toBe('VP · no volume')
  })
})

describe('settings', () => {
  test('are persisted per pane and change the source on rebind', () => {
    const { plugin, ctx } = setup()
    plugin.paneState?.hydrate({ 0: { mode: 'session', rows: 40 } })
    expect(plugin.paneState?.snapshot()[0]).toMatchObject({ mode: 'session' })
    // Session mode wants the finest intraday base even under a daily chart.
    expect(plugin.bind(ctx('1D'))?.sources.map((s) => s.key)).toEqual(['vp-bars|oanda:EURUSD|1m'])
  })
})
