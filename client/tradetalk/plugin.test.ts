import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { dailyWindow } = await import('./api')
const { clockFor, createTradeTalkPlugin, isSessionDated } = await import('./plugin')
const { DEFAULT_PARAMS, settingsOf, summaryText, tradeLabel } = await import('./templates')
import type { SymbolInfo } from '../../src'
import type { BindContext, BindingState, PluginFacilities } from '../plugins/types'
import type { Trade } from './rules'

const SYMBOL = {
  ticker: 'EURUSD',
  pricePrecision: 5,
  timezone: 'America/New_York',
  dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false }
} as unknown as SymbolInfo

describe('the chart clock', () => {
  test('daily and coarser bars are dated by their session, intraday ones by their open', () => {
    expect(isSessionDated('1h')).toBe(false)
    expect(isSessionDated('30m')).toBe(false)
    expect(isSessionDated('1D')).toBe(true)
    expect(isSessionDated('12M')).toBe(true)
    expect(isSessionDated('1Y')).toBe(true)
  })

  test('an instrument with a schedule gets one; one without gets nothing at all', () => {
    expect(clockFor(SYMBOL, '1h')).toEqual({ timezone: 'America/New_York', openOffset: -7, sessionDated: false })
    expect(clockFor({ ...SYMBOL, dayGeometry: undefined } as SymbolInfo, '1h')).toBeNull()
    expect(clockFor({ ...SYMBOL, timezone: undefined } as SymbolInfo, '1h')).toBeNull()
  })
})

describe('the daily window', () => {
  test('reaches back to the start of the year before the chart, so last year is whole', () => {
    const from = Date.UTC(2026, 8, 1)
    const window = dailyWindow({ from, to: Date.UTC(2026, 8, 20) })
    expect(window.to).toBe(Date.UTC(2026, 8, 20))
    expect(window.from).toBeLessThanOrEqual(Date.UTC(2025, 0, 1))
    expect(window.from).toBeGreaterThan(Date.UTC(2024, 11, 20))
  })

  test('never moves the left edge forwards', () => {
    const range = { from: 0, to: 1000 }
    expect(dailyWindow(range).from).toBe(0)
  })
})

describe('the parameters', () => {
  test('the defaults are his own numbers: 2:1, the daily EMA, London through the New York morning', () => {
    expect(settingsOf(DEFAULT_PARAMS)).toEqual({ rr: 2, bias: 1, window: 1, expiry: 5, minUnit: 'D', lines: true })
  })

  test('anything unreadable or out of range settles on something drawable', () => {
    expect(settingsOf(undefined)).toEqual(settingsOf(DEFAULT_PARAMS))
    expect(settingsOf([-1, 9, 9, 0, 9, 2])).toMatchObject({ rr: 0, bias: 2, window: 2, expiry: 1, minUnit: 'M', lines: true })
    expect(settingsOf([3, 0, 0, 10, 1, 0])).toEqual({ rr: 3, bias: 0, window: 0, expiry: 10, minUnit: 'W', lines: false })
  })
})

describe('what the pane says about itself', () => {
  const settings = settingsOf(DEFAULT_PARAMS)
  const none = { bias: 0, rr: 0, hours: 0, invalidated: 0, expired: 0 }

  test('it never claims a result it has not got', () => {
    expect(summaryText(undefined, settings)).toBe('TradeTalk · no bars')
    expect(summaryText({ entries: 0, target: 0, stop: 0, open: 0, sessions: 0, units: ['D'], skips: none }, settings)).toContain('loading')
    expect(summaryText({ entries: 0, target: 0, stop: 0, open: 0, sessions: 40, units: [], skips: none }, settings)).toContain('no level')
  })

  test('with trades it counts them and states the bar they had to clear', () => {
    const text = summaryText({ entries: 3, target: 1, stop: 1, open: 1, sessions: 40, units: ['W'], skips: none }, settings)
    expect(text).toBe('TradeTalk · 3 entries · 1 target · 1 stopped · 1 open · min 2.0R')
  })

  test('an empty pane says which filter emptied it, worst first and no more than three', () => {
    const text = summaryText(
      { entries: 0, target: 0, stop: 0, open: 0, sessions: 40, units: ['D'], skips: { bias: 8, rr: 3, hours: 5, invalidated: 1, expired: 2 } },
      settings
    )
    expect(text).toBe('TradeTalk · 0 entries · min 2.0R · skipped 8 against the bias, 5 outside the hours, 3 short of the reward')
  })
})

describe('the label on an entry', () => {
  test('says the side, the level, where it is going and what it is worth', () => {
    const trade = {
      side: 'long',
      level: { label: 'Aug low', unit: 'M', kind: 'low', price: 1.08, current: false },
      target: { price: 1.09, label: 'week open', isLevel: true },
      rr: 2.42,
      halfSize: true
    } as Trade
    expect(tradeLabel(trade)).toBe('L Aug low › week open 2.4R ½')
  })
})

describe('the binding', () => {
  const plugin = createTradeTalkPlugin()
  plugin.register({ resolutionDurationMs: () => 3_600_000 } as unknown as PluginFacilities)
  const ctx = (name: string, calcParams: number[], symbol: SymbolInfo = SYMBOL): BindContext =>
    ({
      chart: {},
      pane: {},
      paneIndex: 0,
      indicator: { name, calcParams },
      symbol,
      vendor: 'oanda',
      ticker: 'EURUSD',
      interval: '1h',
      siblings: []
    }) as unknown as BindContext
  const state = (phase: string | null): BindingState =>
    ({ sources: phase === null ? [] : [{ id: 'daily', key: 'k', store: { phase } }], chartInterval: '1h' }) as unknown as BindingState

  test('both templates are this plugin\'s, and nothing else is', () => {
    expect(plugin.matches('TT:entries')).toBe(true)
    expect(plugin.matches('TT:heathlevels')).toBe(true)
    expect(plugin.matches('SWING')).toBe(false)
  })

  test('Heath levels reads daily bars only while its calendar switch is on', () => {
    expect(plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12, 1]))?.sources).toHaveLength(1)
    expect(plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12, 0]))?.sources).toHaveLength(0)
    // A layout saved before the switch existed reads it as on.
    expect(plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12]))?.sources).toHaveLength(1)
  })

  test('the legend says what the calendar levels are waiting for, and nothing when they are off', () => {
    expect(plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12, 1]))?.label(state('loading'))).toBe(
      'Heath levels · calendar levels loading'
    )
    expect(plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12, 1]))?.label(state('ready'))).toBe('Heath levels')
    expect(plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12, 0]))?.label(state(null))).toBe('Heath levels')
  })

  test('an instrument with no schedule reads nothing and says why', () => {
    const noSchedule = { ...SYMBOL, dayGeometry: undefined } as SymbolInfo
    const binding = plugin.bind(ctx('TT:heathlevels', [5, 5, 0, 0, 0, 12, 1], noSchedule))
    expect(binding?.sources).toHaveLength(0)
    expect(binding?.label(state(null))).toBe('Heath levels · no schedule for calendar levels')
  })

  test('TradeTalk entries always reads daily bars', () => {
    expect(plugin.bind(ctx('TT:entries', [2, 1, 1, 5, 0, 1]))?.sources).toHaveLength(1)
    expect(plugin.bind(ctx('TT:entries', [2, 1, 1, 5, 0, 1]))?.label(state('ready'))).toBe('TradeTalk')
  })
})
