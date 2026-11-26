import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { KLineData } from 'klinecharts'
import type { SimSnapshot, SimTrade } from './api'
import type { SessionListener, TradingSession } from './session'

// The Performance tab rendered into a real DOM (happy-dom): the bars it draws for a snapshot, the
// buttons that pick the measure and the range, and that past equity reads its bars once -- a
// poll that changes nothing but the quotes must not read them again. The DOM is this file's only.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { PerformanceView, barPath } = await import('./perfview')
const { setTradePrefs } = await import('./prefs')

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 13, 12)
const START = NOW - 48 * HOUR

function trade(over: Partial<SimTrade> = {}): SimTrade {
  return {
    id: 't1',
    symbol: 'oanda:EURUSD',
    side: 'buy',
    units: 10_000,
    entryPrice: 1.1,
    openedAt: START,
    orderId: 'o1',
    stopLoss: null,
    takeProfit: null,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    realizedPnl: null,
    label: null,
    ...over
  }
}

function session(trades: SimTrade[], balance: number, equity = balance): TradingSession & { snapshot: SimSnapshot } {
  const snapshot: SimSnapshot = {
    id: 's1',
    mode: 'paper',
    name: 'Paper',
    createdAt: START,
    rev: 1,
    account: { currency: 'USD', initialBalance: 10_000, balance, unrealizedPnl: equity - balance, equity },
    quotes: {},
    orders: [],
    trades,
    symbols: []
  }
  return {
    mode: 'paper',
    snapshot,
    ready: true,
    subscribe: (_listener: SessionListener) => () => {},
    watch: async () => {},
    placeOrder: async () => {},
    cancelOrder: async () => {},
    modifyOrder: async () => {},
    modifyTrade: async () => {},
    closeTrade: async () => {},
    flatten: async () => {}
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the Performance tab', () => {
  test('balance: one bar per hour since the account began, the last the account now', () => {
    setTradePrefs({ perfMetric: 'balance', perfRange: '1M' })
    // +50 a day in, so the bars are flat at the start, then up.
    const s = session([trade({ closedAt: START + 24 * HOUR, closePrice: 1.105, realizedPnl: 50 })], 10_050)
    const view = new PerformanceView(s, { grid: () => null, now: () => NOW, fetchBars: async () => [] })
    document.body.appendChild(view.element)
    view.render()
    const bars = view.element.querySelectorAll('.wd-perf-bar')
    // Two days of hours from the account's start: the window is clamped to it.
    expect(bars.length).toBe(48)
    expect(view.element.querySelectorAll('.wd-perf-bar.is-live')).toHaveLength(1)
    expect(view.element.querySelector('.wd-perf-value')?.textContent).toBe('Balance 10,050.00 USD')
    expect(view.element.querySelector('.wd-perf-change')?.textContent).toBe('+50.00 USD · +0.50%')
    expect(view.element.querySelector('.wd-perf-since')?.textContent).toStartWith('since the account began')
    // Before the close the bars sit on the line; after it they are gains.
    expect(view.element.querySelectorAll('.wd-perf-bar.is-flat').length).toBe(23)
    expect([...bars].slice(24).every((b) => b.getAttribute('fill') === '#26a69a')).toBe(true)
    view.dispose()
    view.element.remove()
  })

  test('the buttons pick the measure and the range, and say which is on', () => {
    setTradePrefs({ perfMetric: 'balance', perfRange: '1M' })
    const view = new PerformanceView(session([], 10_000), { grid: () => null, now: () => NOW, fetchBars: async () => [] })
    view.render()
    const button = (label: string) => [...view.element.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement
    expect(button('1M').getAttribute('aria-pressed')).toBe('true')
    button('6M').click()
    expect(button('6M').getAttribute('aria-pressed')).toBe('true')
    expect(button('1M').getAttribute('aria-pressed')).toBe('false')
    button('Equity').click()
    expect(button('Equity').classList.contains('is-active')).toBe(true)
    view.dispose()
  })

  test('equity: past marks read once from hourly bars, and a poll does not read them again', async () => {
    setTradePrefs({ perfMetric: 'equity', perfRange: '1M' })
    // A long open since the start, worth +30 now; hourly bars rise 1 pip an hour.
    const s = session([trade()], 10_000, 10_030)
    const calls: Array<[string, string, number, number]> = []
    const fetchBars = async (symbol: string, resolution: string, from: number, to: number): Promise<KLineData[]> => {
      calls.push([symbol, resolution, from, to])
      const out: KLineData[] = []
      for (let t = Math.ceil(from / HOUR) * HOUR; t < to; t += HOUR) {
        const close = 1.1 + ((t - START) / HOUR) * 0.0001
        out.push({ timestamp: t, open: close, high: close, low: close, close })
      }
      return out
    }
    const view = new PerformanceView(s, { grid: () => null, now: () => NOW, fetchBars })
    view.render()
    expect(view.element.querySelector('.wd-perf-plot')?.classList.contains('is-loading')).toBe(true)
    await tick()
    await tick()
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('oanda:EURUSD')
    expect(calls[0][1]).toBe('1h')
    const bars = view.element.querySelectorAll('.wd-perf-bar')
    expect(bars.length).toBe(48)
    // The bar ending 10h in marks the bar that closed at 10h (opened 9h): 9 pips on 10K = +9.
    const titles = [...view.element.querySelectorAll('.wd-perf-hit title')].map((t) => t.textContent ?? '')
    expect(titles[9]).toContain('10,009.00')
    expect(titles[47]).toContain('10,030.00')
    // A poll: same trades, new quote time.
    s.snapshot.rev = 2
    view.render()
    await tick()
    expect(calls).toHaveLength(1)
    view.dispose()
  })

  test('a bar is rounded at its data end and square on the baseline, up or down', () => {
    const up = barPath(10, 100, 8, 40, true)
    expect(up.startsWith('M10,100V64A4,4 0 0 1 14,60')).toBe(true)
    const down = barPath(10, 100, 8, 40, false)
    expect(down.startsWith('M10,100V136A4,4 0 0 0 14,140')).toBe(true)
    // Too thin to round: a plain rectangle.
    expect(barPath(10, 100, 1, 40, true)).toBe('M10,100H11V60H10Z')
  })
})
