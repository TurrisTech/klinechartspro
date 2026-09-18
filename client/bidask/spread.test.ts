import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { DEFAULT_UNIT, spreadPrecision, spreadUnit, spreadUnitLabel, spreadValue, SPREAD_TEMPLATE_NAME, UNIT_BP, UNIT_POINTS, UNIT_PRICE } =
  await import('./spread')
const { createBidAskPlugin } = await import('./plugin')
const { quoteSourceKey } = await import('./api')
import type { BindContext, BindingState, PluginFacilities, SourceStore } from '../plugins/types'
import type { QuotePoint } from './api'

// The spread sub-pane: the unit arithmetic, and that it binds to the same store as the
// price-pane bid/ask.

// dev `/getbars?columns=all`, EURUSD 1h, 2026-09-17: ask close 1.1461, bid close 1.14593.
const Q: QuotePoint = { date: 0, bo: 1.14574, bh: 1.14608, bl: 1.14566, bc: 1.14593, ao: 1.1459, ah: 1.14623, al: 1.14582, ac: 1.1461 }

describe('spreadValue', () => {
  test('price, points and bp of the close', () => {
    expect(spreadValue(Q, UNIT_PRICE, 1e-5).spread).toBeCloseTo(0.00017, 12)
    expect(spreadValue(Q, UNIT_POINTS, 1e-5).spread).toBeCloseTo(17, 9)
    expect(spreadValue(Q, UNIT_BP, 1e-5).spread).toBeCloseTo((0.00017 / 1.146015) * 10_000, 9)
  })
  test('a bar without a quote, or points with no known point size, is nothing', () => {
    expect(spreadValue(undefined, UNIT_POINTS, 1e-5)).toEqual({})
    expect(spreadValue(Q, UNIT_POINTS, 0)).toEqual({})
  })
})

describe('unit param', () => {
  test('snapped to the three units, default otherwise', () => {
    expect(spreadUnit([0])).toBe(UNIT_PRICE)
    expect(spreadUnit(['2'])).toBe(UNIT_BP)
    expect(spreadUnit([1.2])).toBe(UNIT_POINTS)
    expect(spreadUnit([7])).toBe(DEFAULT_UNIT)
    expect(spreadUnit([])).toBe(DEFAULT_UNIT)
    expect(spreadUnit(undefined)).toBe(DEFAULT_UNIT)
    expect(spreadUnitLabel(UNIT_BP)).toBe('bp')
  })
  test('precision follows the unit', () => {
    expect(spreadPrecision(UNIT_PRICE, 3)).toBe(3)
    expect(spreadPrecision(UNIT_POINTS, 3)).toBe(1)
    expect(spreadPrecision(UNIT_BP, 3)).toBe(2)
  })
})

describe('plugin', () => {
  const f = {
    api: { get: async () => ({ s: 'no_data' }) },
    resolutionDurationMs: () => 3_600_000,
    stream: { subscribe: () => {}, unsubscribe: () => {} }
  } as unknown as PluginFacilities

  const ctx = (name: string, calcParams: unknown[]) =>
    ({
      indicator: { name, calcParams },
      symbol: { ticker: 'EURUSD', pricePrecision: 5 },
      vendor: 'oanda',
      ticker: 'EURUSD',
      interval: '1h'
    }) as unknown as BindContext

  test('both templates bind to one store key', () => {
    const plugin = createBidAskPlugin()
    const groups = plugin.register(f) as Array<{ main: boolean; items: Array<{ name: string }> }>
    expect(groups.find((g) => !g.main)?.items.map((i) => i.name)).toEqual([SPREAD_TEMPLATE_NAME])
    expect(plugin.matches(SPREAD_TEMPLATE_NAME)).toBe(true)
    const spread = plugin.bind(ctx(SPREAD_TEMPLATE_NAME, [UNIT_POINTS]))
    const bidask = plugin.bind(ctx('QUOTE:bidask', [15]))
    const key = quoteSourceKey('oanda', 'EURUSD', '1h')
    expect(spread?.sources[0].key).toBe(key)
    expect(bidask?.sources[0].key).toBe(key)
    expect(spread?.overrides).toEqual({ precision: 1 })
    const state = { sources: [{ id: 'quote', key, store: {} as SourceStore }], chartInterval: '1h' } as BindingState
    expect(spread?.extendData?.(state)).toEqual({ pointSize: 1e-5 })
  })

  test('the legend names the unit and says when there are no quotes', () => {
    const plugin = createBidAskPlugin()
    plugin.register(f)
    const spec = plugin.bind(ctx(SPREAD_TEMPLATE_NAME, [UNIT_BP]))
    const state = (phase: string, size: number) =>
      ({ sources: [{ id: 'quote', key: 'k', store: { phase, size } as unknown as SourceStore }], chartInterval: '1h' }) as BindingState
    expect(spec?.label(state('loading', 0))).toBe('SPREAD bp · loading')
    expect(spec?.label(state('ready', 0))).toBe('SPREAD bp · no quotes for this instrument')
    expect(spec?.label(state('ready', 3))).toBe('SPREAD bp')
    expect(spec?.overrides).toEqual({ precision: 2 })
  })
})
