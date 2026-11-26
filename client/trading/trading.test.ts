import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimOrder, SimSnapshot, SimTrade } from './api'
import type { DraftOrder } from './lines'

// format.ts -> symbols.ts -> config.ts reads `window` at import, so the DOM stub has to exist
// before those load -- hence installWindow() then the dynamic imports (same as api.test.ts).
installWindow()
const { pipsToPrice, toPips, tradePips, tradePnl } = await import('./format')
const { DEFAULT_COLORS, linesFor, overlaysFor } = await import('./overlays')
const { applyAmendment, bracketFigures, currentLevel, historyFigures, isComposing } = await import('./lines')
const { formatInstant, formatShare } = await import('./format')
const { formatClock } = await import('../replay/format')
const { bracketDatum } = await import('./overlays')

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

describe('the draft', () => {
  const draft = (over: Partial<DraftOrder> = {}): DraftOrder => ({
    symbol: KEY,
    side: 'buy',
    type: 'market',
    units: 10_000,
    entry: 1.1,
    stop: null,
    target: null,
    problem: null,
    riskPercent: null,
    ...over
  })

  test('a market draft with no levels is not drawn: it would only sit on the price line', () => {
    expect(linesFor(snapshot(), KEY, draft())).toHaveLength(0)
    expect(isComposing(draft())).toBe(false)
  })

  test('once it has a level it draws first, every line draggable, and only on its instrument', () => {
    const d = draft({ type: 'limit', entry: 1.09, stop: 1.08, target: 1.11 })
    const lines = linesFor(snapshot({ trades: [trade()] }), KEY, d)
    expect(lines.slice(0, 3).map((l) => [l.owner, l.role, l.price, l.draggable])).toEqual([
      ['draft', 'entry', 1.09, true],
      ['draft', 'stop', 1.08, true],
      ['draft', 'target', 1.11, true]
    ])
    expect(linesFor(snapshot(), 'oanda:GBP_USD', d)).toHaveLength(0)
  })

  test('while composing, working lines are dimmed and an unselected bracket is not drawn selected', () => {
    const s = snapshot({ trades: [trade({ stopLoss: 1.09 })] })
    const d = draft({ stop: 1.095 })
    const overlays = overlaysFor(s, KEY, SPAN, DEFAULT_COLORS, null, d)
    const lineColors = overlays
      .filter((o) => o.name === 'wdTradeLine')
      .map((o) => [(o.extendData as { wd: { owner: string } }).wd.owner, (o.styles as { line: { color: string } }).line.color])
    expect(lineColors.filter(([owner]) => owner === 'trade').every(([, c]) => c.startsWith('rgba'))).toBe(true)
    expect(lineColors.filter(([owner]) => owner === 'draft').every(([, c]) => c.startsWith('#'))).toBe(true)
    const brackets = overlays.filter((o) => o.name === 'wdTradeBracket').map((o) => (o.extendData as { wd: { owner: string; selected: boolean } }).wd)
    expect(brackets).toEqual([expect.objectContaining({ owner: 'draft', selected: true }), expect.objectContaining({ owner: 'trade', selected: false })])
  })

  test('a position the user selected stays selected and undimmed beside a draft', () => {
    const s = snapshot({ trades: [trade({ stopLoss: 1.09 })] })
    const overlays = overlaysFor(s, KEY, SPAN, DEFAULT_COLORS, 't1', draft({ stop: 1.095 }))
    const trade1 = overlays.filter((o) => o.name === 'wdTradeLine' && (o.extendData as { wd: { owner: string } }).wd.owner === 'trade')
    expect(trade1.every((o) => (o.styles as { line: { color: string } }).line.color.startsWith('#'))).toBe(true)
    const bracket = overlays.find((o) => o.name === 'wdTradeBracket' && (o.extendData as { wd: { owner: string } }).wd.owner === 'trade')
    expect(bracket?.extendData).toMatchObject({ wd: { selected: true } })
  })
})

describe('amendments waiting for confirmation', () => {
  test('the chart draws the snapshot as if confirmed; a removal waits, marked, on its line', () => {
    const s = snapshot({ trades: [trade({ stopLoss: 1.09 })], orders: [order()] })
    const moved = applyAmendment(s, { owner: 'trade', id: 't1', role: 'stop', price: 1.095, from: 1.09 })
    expect(moved.trades[0].stopLoss).toBe(1.095)
    expect(s.trades[0].stopLoss).toBe(1.09) // the real snapshot is untouched
    expect(applyAmendment(s, { owner: 'order', id: 'o1', role: 'order', price: 1.085, from: 1.09 }).orders[0].price).toBe(1.085)
    expect(applyAmendment(s, { owner: 'trade', id: 't1', role: 'stop', price: null, from: 1.09 })).toBe(s)
  })

  test('currentLevel: the level now, null for none, undefined once the position is gone', () => {
    const s = snapshot({ trades: [trade({ takeProfit: null }), trade({ id: 't2', closedAt: 5, stopLoss: 1.08 })], orders: [order()] })
    expect(currentLevel(s, 'trade', 't1', 'target')).toBeNull()
    expect(currentLevel(s, 'trade', 't2', 'stop')).toBeUndefined()
    expect(currentLevel(s, 'order', 'o1', 'order')).toBe(1.09)
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

describe('bracketFigures', () => {
  // A price -> y that is easy to read back: 1.10 -> 100, one pip a pixel... near enough.
  const toY = (p: number) => Math.round((1.2 - p) * 1000)
  const connector = (figures: ReturnType<typeof bracketFigures>) => figures.filter((f) => f.type === 'line')
  const datum = (owner: 'trade' | 'draft', side: 'buy' | 'sell', selected = true) =>
    bracketDatum(owner, 'x', side, 1.1, 1.09, 1.12, selected, DEFAULT_COLORS).wd

  test('the connector runs down the gap before the anchor bar, never down its centre (a wick)', () => {
    // The draft's anchor is the live candle: drawn at its centre, the connector read as its wick.
    const lines = connector(bracketFigures(datum('draft', 'buy'), 400, 5, 800, toY))
    expect(lines).toHaveLength(1)
    const xs = (lines[0].attrs as { coordinates: { x: number; y: number }[] }).coordinates.map((c) => c.x)
    expect(xs).toEqual([395, 395])
    expect((lines[0].attrs as { coordinates: { y: number }[] }).coordinates.map((c) => c.y)).toEqual([toY(1.09), toY(1.12)])
  })

  test('the connector is neither candle colour, whichever side the position is', () => {
    for (const side of ['buy', 'sell'] as const) {
      const [line] = connector(bracketFigures(datum('trade', side), 400, 5, 800, toY))
      const color = (line.styles as { color: string }).color
      expect(color).toBe(DEFAULT_COLORS.connector)
      expect([DEFAULT_COLORS.buy, DEFAULT_COLORS.sell]).not.toContain(color)
    }
  })

  test('the bands start at the same edge; only the fill dot sits on the bar', () => {
    const figures = bracketFigures(datum('trade', 'buy'), 400, 5, 800, toY)
    const rects = figures.filter((f) => f.type === 'rect').map((f) => f.attrs as { x: number; width: number })
    expect(rects).toEqual([expect.objectContaining({ x: 395, width: 405 }), expect.objectContaining({ x: 395, width: 405 })])
    const dot = figures.find((f) => f.type === 'circle')
    expect(dot?.attrs).toMatchObject({ x: 400, y: toY(1.1) })
  })

  test('no connector when it is not selected, or its edge is off the pane; bands still drawn', () => {
    expect(connector(bracketFigures(datum('trade', 'buy', false), 400, 5, 800, toY))).toHaveLength(0)
    const scrolled = bracketFigures(datum('trade', 'buy'), 3, 5, 800, toY)
    expect(connector(scrolled)).toHaveLength(0)
    expect(scrolled.filter((f) => f.type === 'rect').map((f) => (f.attrs as { x: number }).x)).toEqual([0, 0])
  })
})

describe('closed trades on the chart', () => {
  const history = (overlays: ReturnType<typeof overlaysFor>) => overlays.filter((o) => o.name === 'wdTradeHistory')
  const closedTrade = (over: Partial<SimTrade> = {}) =>
    trade({ id: 'c1', openedAt: 1_200, closedAt: 1_700, closePrice: 1.102, closeReason: 'take_profit', realizedPnl: 2, ...over })
  // A pane whose bars are 100ms wide: an instant lands on the bar that was open then.
  const options = { toBar: (ms: number) => Math.floor(ms / 100) * 100, text: (t: SimTrade, selected: boolean) => (selected ? `${t.id} selected` : t.id) }

  test('drawn only when asked: no history option, no closed trade', () => {
    const s = snapshot({ trades: [closedTrade()] })
    expect(history(overlaysFor(s, KEY, SPAN, DEFAULT_COLORS))).toHaveLength(0)
  })

  test('its entry and exit sit on the bars open at those instants, at its prices, locked', () => {
    const s = snapshot({ trades: [closedTrade({ openedAt: 1_234, closedAt: 1_789 })] })
    const [h] = history(overlaysFor(s, KEY, SPAN, DEFAULT_COLORS, null, null, options))
    expect(h.points).toEqual([
      { timestamp: 1_200, value: 1.1 },
      { timestamp: 1_700, value: 1.102 }
    ])
    expect(h.lock).toBe(true)
    expect(h.extendData).toMatchObject({ wd: { owner: 'history', id: 'c1', result: 1, selected: false, text: 'c1' } })
  })

  test('only its own instrument, only what ends inside the loaded bars, oldest first, beneath the lines', () => {
    const s = snapshot({
      trades: [
        closedTrade({ id: 'late', openedAt: 1_500 }),
        closedTrade({ id: 'early', openedAt: 1_100 }),
        closedTrade({ id: 'gone', openedAt: 10, closedAt: 900 }),
        closedTrade({ id: 'other', symbol: 'oanda:GBP_USD' }),
        trade({ id: 'open', stopLoss: 1.09 })
      ]
    })
    const overlays = overlaysFor(s, KEY, SPAN, DEFAULT_COLORS, null, null, options)
    expect(history(overlays).map((o) => (o.extendData as { wd: { id: string } }).wd.id)).toEqual(['early', 'late'])
    expect(overlays.findIndex((o) => o.name === 'wdTradeLine')).toBeGreaterThan(overlays.findIndex((o) => o.name === 'wdTradeHistory'))
  })

  test('the selected one says more, and a loss is a loss', () => {
    const s = snapshot({ trades: [closedTrade({ realizedPnl: -3 })] })
    const [h] = history(overlaysFor(s, KEY, SPAN, DEFAULT_COLORS, 'c1', null, options))
    expect(h.extendData).toMatchObject({ wd: { selected: true, result: -1, text: 'c1 selected' } })
  })

  test('figures: a dot at the fill, a ring at the exit, the path in the result’s colour, the result beside it', () => {
    const datum = {
      owner: 'history' as const,
      id: 'c1',
      side: 'buy' as const,
      entry: 1.1,
      exit: 1.102,
      stop: 1.098,
      target: 1.104,
      text: '+20.0p',
      result: 1 as const,
      selected: false,
      entryColor: DEFAULT_COLORS.buy,
      profitColor: DEFAULT_COLORS.target,
      lossColor: DEFAULT_COLORS.stop,
      flatColor: DEFAULT_COLORS.connector
    }
    const toY = (price: number) => (1.2 - price) * 1000
    const figures = historyFigures(datum, { x: 100, y: toY(1.1) }, { x: 300, y: toY(1.102) }, 800, toY)
    expect(figures.map((f) => f.type)).toEqual(['line', 'circle', 'circle', 'text'])
    expect(figures[0].styles).toMatchObject({ style: 'dashed', color: expect.stringContaining('rgba(38, 166, 154') })
    expect(figures[1]).toMatchObject({ attrs: { x: 100 }, styles: { style: 'fill', color: DEFAULT_COLORS.buy } })
    expect(figures[2]).toMatchObject({ attrs: { x: 300 }, styles: { style: 'stroke', borderColor: DEFAULT_COLORS.target } })
    expect(figures[3].attrs).toMatchObject({ text: '+20.0p', x: 307, align: 'left' })
    // At the live edge the result goes to the ring's left rather than under the price axis.
    const edge = historyFigures(datum, { x: 100, y: toY(1.1) }, { x: 790, y: toY(1.102) }, 800, toY)
    expect(edge[3].attrs).toMatchObject({ x: 783, align: 'right' })
    // Selected, its last stop and target are bands over the time it was open, which take no clicks.
    const selected = historyFigures({ ...datum, selected: true }, { x: 100, y: toY(1.1) }, { x: 300, y: toY(1.102) }, 800, toY)
    const bands = selected.filter((f) => f.type === 'rect')
    expect(bands.map((f) => f.attrs)).toEqual([expect.objectContaining({ x: 100, width: 200 }), expect.objectContaining({ x: 100, width: 200 })])
    expect(bands.every((f) => f.ignoreEvent === true)).toBe(true)
  })
})

describe('times to the second', () => {
  test('the trading UI and the replay clock both print seconds, and midnight is 00, not 24', () => {
    const at = Date.UTC(2026, 10, 13, 19, 5, 9) // 14:05:09 New York
    expect(formatInstant(at)).toBe('Nov 13, 14:05:09')
    expect(formatClock(at, 'America/New_York')).toBe('Fri, Nov 13, 14:05:09')
    expect(formatClock(Date.UTC(2026, 10, 14, 0, 0, 7), 'UTC')).toBe('Sat, Nov 14, 00:00:07')
  })
})

describe('a share of the balance', () => {
  test('two decimals from 0.1% up; below that, two significant figures, never a bare 0.00%', () => {
    expect(formatShare(1.2345)).toBe('+1.23%')
    expect(formatShare(-0.25)).toBe('−0.25%')
    expect(formatShare(0.012)).toBe('+0.012%')
    // −2.30 on a 100K balance: what a 10K EURUSD position typically is.
    expect(formatShare(-0.0023)).toBe('−0.0023%')
    expect(formatShare(0.00001)).toBe('0.0000%')
    expect(formatShare(0)).toBe('0.00%')
    expect(formatShare(null)).toBe('—')
  })
})
