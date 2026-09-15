import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimOrder, SimSnapshot, SimTrade } from './api'

// format.ts -> symbols.ts -> config.ts reads `window` at import, so the DOM stub has to exist
// before those load -- hence installWindow() then the dynamic imports (same as api.test.ts).
installWindow()
const { pipsToPrice, toPips, tradePips, tradePnl } = await import('./format')
const { DEFAULT_COLORS, linesFor, overlaysFor } = await import('./overlays')

const KEY = 'oanda:EUR_USD'
const SPAN = { first: 1_000, last: 2_000 }

function snapshot(over: Partial<SimSnapshot> = {}): SimSnapshot {
  return {
    id: 's1',
    mode: 'paper',
    name: 'Paper',
    createdAt: 0,
    rev: 1,
    account: { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 },
    quotes: {},
    orders: [],
    trades: [],
    symbols: [KEY],
    ...over
  }
}

function trade(over: Partial<SimTrade> = {}): SimTrade {
  return {
    id: 't1',
    symbol: KEY,
    side: 'buy',
    units: 1000,
    entryPrice: 1.1,
    openedAt: 0,
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

function order(over: Partial<SimOrder> = {}): SimOrder {
  return {
    id: 'o1',
    symbol: KEY,
    side: 'buy',
    type: 'limit',
    units: 1000,
    price: 1.09,
    stopLoss: null,
    takeProfit: null,
    status: 'pending',
    createdAt: 0,
    filledAt: null,
    fillPrice: null,
    tradeId: null,
    label: null,
    ...over
  }
}

describe('overlaysFor', () => {
  const lines = (overlays: ReturnType<typeof overlaysFor>) => overlays.filter((o) => o.name === 'wdTradeLine')
  const brackets = (overlays: ReturnType<typeof overlaysFor>) => overlays.filter((o) => o.name === 'wdTradeBracket')

  test('a pending order draws one draggable line at its price, and no bracket without a stop or target', () => {
    const s = snapshot({ orders: [order()] })
    const overlays = overlaysFor(s, KEY, SPAN, DEFAULT_COLORS)
    expect(lines(overlays)).toHaveLength(1)
    expect(brackets(overlays)).toHaveLength(0)
    expect(overlays[0].lock).toBe(false)
    expect(overlays[0].points?.[0]?.value).toBe(1.09)
  })

  test("a pending order's stop and target are lines too, joined to its price by a bracket", () => {
    const s = snapshot({ orders: [order({ stopLoss: 1.08, takeProfit: 1.1 })] })
    const overlays = overlaysFor(s, KEY, SPAN, DEFAULT_COLORS)
    expect(lines(overlays).map((o) => o.points?.[0]?.value)).toEqual([1.09, 1.08, 1.1])
    expect(lines(overlays).every((o) => o.lock === false)).toBe(true)
    expect(brackets(overlays)).toHaveLength(1)
  })

  test('an open trade draws its entry (locked) plus draggable stop and target, and a bracket', () => {
    const s = snapshot({ trades: [trade({ stopLoss: 1.09, takeProfit: 1.12 })] })
    const overlays = overlaysFor(s, KEY, SPAN, DEFAULT_COLORS)
    expect(lines(overlays)).toHaveLength(3)
    const draggable = lines(overlays).filter((o) => o.lock === false)
    expect(draggable).toHaveLength(2) // stop and target only; the entry is locked
    expect(new Set(draggable.map((o) => o.points?.[0]?.value))).toEqual(new Set([1.09, 1.12]))
    const bracket = brackets(overlays)[0]
    expect(bracket.extendData).toMatchObject({ wd: { entry: 1.1, stop: 1.09, target: 1.12, selected: false } })
  })

  test('the bracket is anchored at the bar the trade opened on, clamped to the loaded bars', () => {
    const s = snapshot({ trades: [trade({ openedAt: 1_500 }), trade({ id: 't2', openedAt: 10 })] })
    const anchors = brackets(overlaysFor(s, KEY, SPAN, DEFAULT_COLORS)).map((o) => o.points?.[0]?.timestamp)
    expect(anchors).toEqual([SPAN.first, 1_500]) // sorted oldest first; t2 predates the data
  })

  test('the selected trade is the one drawn strongly', () => {
    const s = snapshot({ trades: [trade(), trade({ id: 't2', openedAt: 5 })] })
    const selected = brackets(overlaysFor(s, KEY, SPAN, DEFAULT_COLORS, 't2')).map(
      (o) => (o.extendData as { wd: { id: string; selected: boolean } }).wd
    )
    expect(selected).toEqual([expect.objectContaining({ id: 't1', selected: false }), expect.objectContaining({ id: 't2', selected: true })])
  })

  test('overlays for another pane’s instrument, and closed trades, are excluded', () => {
    const s = snapshot({
      trades: [trade({ symbol: 'oanda:GBP_USD' }), trade({ id: 't2', closedAt: 5 })]
    })
    expect(overlaysFor(s, KEY, SPAN, DEFAULT_COLORS)).toHaveLength(0)
  })

  test('linesFor marks only stops, targets and pending prices draggable', () => {
    const s = snapshot({ trades: [trade({ stopLoss: 1.09 })], orders: [order()] })
    expect(linesFor(s, KEY).map((l) => [l.role, l.draggable])).toEqual([
      ['order', true],
      ['entry', false],
      ['stop', true]
    ])
  })
})

describe('pip math', () => {
  test('pipsToPrice puts a stop below a long and a target above', () => {
    // EURUSD pip = 0.0001; 10 pips from 1.1000
    expect(pipsToPrice(1.1, 10, 0.0001, true)).toBeCloseTo(1.099, 10) // below
    expect(pipsToPrice(1.1, 10, 0.0001, false)).toBeCloseTo(1.101, 10) // above
  })

  test('toPips expresses a price delta in pips, or null off-pip', () => {
    expect(toPips(0.0005, 0.0001)).toBeCloseTo(5, 10)
    expect(toPips(0.0005, null)).toBeNull()
  })

  test('tradePnl and tradePips are side-aware against a quote', () => {
    const t = trade({ side: 'buy', entryPrice: 1.1, units: 10_000 })
    const quote = { bid: 1.101, ask: 1.1012 }
    expect(tradePnl(t, quote)).toBeCloseTo(10, 6) // (1.1010 - 1.1000) * 10000
    expect(tradePips(t, quote, 0.0001)).toBeCloseTo(10, 6)
  })
})
