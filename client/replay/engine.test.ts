import { describe, expect, test } from 'bun:test'
import { type BidAskBar, Engine, type Quote, SimError } from './engine'
import cases from './fixtures/engine_cases.json'

// The fill engine's parity suite: the SAME case file wdashboard-server's tests/sim/
// test_engine.py runs (see casefile.py there for the language), vendored verbatim by
// scripts/sync-engine-fixtures.sh. Every rule the Python engine specifies is asserted here
// against the TypeScript port, event by event and field by field.

type Doc = Record<string, unknown>

interface Case {
  name: string
  setup?: { balance?: number; currency?: string }
  feed: Doc[]
  expect: Doc[]
  finalState: { balance: number; clock: number; orders: Doc[]; trades: Doc[] }
}

const doc = cases as unknown as { symbol: string; spread: number; cases: Case[] }
const TOLERANCE = 1e-9

function approx(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b))
  return a === b
}

function expectSubset(actual: Doc, expected: Doc, where: string): void {
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) throw new Error(`${where}: missing ${key} in ${JSON.stringify(actual)}`)
    if (!approx(actual[key], value)) throw new Error(`${where}.${key}: ${JSON.stringify(actual[key])} != ${JSON.stringify(value)}`)
  }
}

function expectEvents(actual: Doc[], expected: Doc[], where: string): void {
  if (actual.length !== expected.length) throw new Error(`${where}: events ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`)
  actual.forEach((a, i) => {
    expectSubset(a, expected[i], `${where}.events[${i}]`)
  })
}

function quote(d: Doc, symbol: string, spread: number): Quote {
  const bid = d.bid as number
  return { symbol: (d.symbol as string) ?? symbol, time: d.t as number, bid, ask: (d.ask as number) ?? bid + spread }
}

function bar(d: Doc, symbol: string, spread: number): BidAskBar {
  const s = (d.spread as number) ?? spread
  const t = d.t as number
  const [o, h, l, c] = [d.o, d.h, d.l, d.c] as number[]
  return {
    symbol: (d.symbol as string) ?? symbol,
    time: t,
    end: (d.end as number) ?? t + 60_000,
    bidOpen: o,
    bidHigh: h,
    bidLow: l,
    bidClose: c,
    askOpen: o + s,
    askHigh: h + s,
    askLow: l + s,
    askClose: c + s
  }
}

/** The case file's tri-state for an amendment: absent -> leave, "unset" -> clear, value. */
function amend(d: Doc, key: string): number | null | undefined {
  if (!(key in d)) return undefined
  return d[key] === 'unset' ? null : (d[key] as number)
}

function check(engine: Engine, d: Doc, where: string, symbol: string): void {
  const simple: Record<string, number> = {
    balance: engine.balance,
    unrealizedPnl: engine.unrealizedPnl(),
    equity: engine.equity(),
    openTrades: engine.openTrades().length,
    pendingOrders: engine.pendingOrders().length,
    clock: engine.clock
  }
  for (const [key, value] of Object.entries(d)) {
    if (key in simple) {
      if (!approx(simple[key], value)) throw new Error(`${where}.${key}: ${simple[key]} != ${value}`)
    } else if (key === 'netPosition') {
      const sym = (d.symbol as string) ?? engine.quotes.keys().next().value ?? symbol
      if (!approx(engine.netPosition(sym), value)) throw new Error(`${where}.netPosition: ${engine.netPosition(sym)} != ${value}`)
    } else if (key === 'quote') {
      const v = value as Doc
      const sym = (v.symbol as string) ?? engine.quotes.keys().next().value ?? symbol
      const q = engine.quotes.get(sym)
      if (!q) throw new Error(`${where}: no quote for ${sym}`)
      const { symbol: _s, ...rest } = v
      expectSubset({ bid: q.bid, ask: q.ask, time: q.time }, rest, `${where}.quote`)
    } else if (key === 'orders') {
      for (const [id, sub] of Object.entries(value as Record<string, Doc>)) {
        const o = engine.orders.get(id)
        if (!o) throw new Error(`${where}: no order ${id}`)
        expectSubset(o as unknown as Doc, sub, `${where}.orders[${id}]`)
      }
    } else if (key === 'trades') {
      for (const [id, sub] of Object.entries(value as Record<string, Doc>)) {
        const t = engine.trades.get(id)
        if (!t) throw new Error(`${where}: no trade ${id}`)
        expectSubset(t as unknown as Doc, sub, `${where}.trades[${id}]`)
      }
    } else if (key !== 'symbol') {
      throw new Error(`${where}: unknown assert key ${key}`)
    }
  }
}

function runCase(c: Case, symbol: string, spread: number): void {
  const engine = new Engine(c.setup?.balance ?? 100_000, c.setup?.currency ?? 'USD')
  const produced: Doc[] = []
  c.feed.forEach((step, index) => {
    const where = `${c.name} / step ${index}`
    const error = step.error as string | undefined
    let events: Doc[] = []
    let order: Doc | null = null
    try {
      if ('quote' in step) events = engine.onQuote(quote(step.quote as Doc, symbol, spread)) as unknown as Doc[]
      else if ('bar' in step) events = engine.onBar(bar(step.bar as Doc, symbol, spread)) as unknown as Doc[]
      else if ('submit' in step) {
        const d = step.submit as Doc
        const r = engine.submit({
          symbol: (d.symbol as string) ?? symbol,
          side: d.side as 'buy' | 'sell',
          type: d.type as 'market' | 'limit' | 'stop',
          units: d.units as number,
          price: d.price as number | undefined,
          stopLoss: d.stopLoss as number | undefined,
          takeProfit: d.takeProfit as number | undefined,
          label: d.label as string | undefined
        })
        order = r.order as unknown as Doc
        events = r.events as unknown as Doc[]
      } else if ('cancel' in step) events = [engine.cancel(step.cancel as string)] as unknown as Doc[]
      else if ('modifyOrder' in step) {
        const d = step.modifyOrder as Doc
        order = engine.modifyOrder(d.id as string, {
          price: d.price as number | undefined,
          stopLoss: amend(d, 'stopLoss'),
          takeProfit: amend(d, 'takeProfit')
        }) as unknown as Doc
      } else if ('modifyTrade' in step) {
        const d = step.modifyTrade as Doc
        engine.modifyTrade(d.id as string, { stopLoss: amend(d, 'stopLoss'), takeProfit: amend(d, 'takeProfit') })
      } else if ('closeTrade' in step) {
        const d = step.closeTrade as Doc
        events = engine.closeTrade(d.id as string, d.units as number | undefined) as unknown as Doc[]
      } else if ('flatten' in step) events = engine.flatten((step.flatten as Doc).symbol as string | undefined) as unknown as Doc[]
      else if ('assert' in step) {
        check(engine, step.assert as Doc, where, symbol)
        return
      } else throw new Error(`${where}: unknown step ${JSON.stringify(step)}`)
    } catch (err) {
      if (!(err instanceof SimError)) throw err
      if (error === undefined) throw new Error(`${where}: unexpected SimError ${err.message}`)
      if (!err.message.includes(error)) throw new Error(`${where}: '${err.message}' does not match '${error}'`)
      return
    }
    if (error !== undefined) throw new Error(`${where}: expected an error matching '${error}'`)
    produced.push(...events)
    const exp = step.expect as Doc | undefined
    if (exp) {
      if ('order' in exp) {
        if (!order) throw new Error(`${where}: no order to check`)
        expectSubset(order, exp.order as Doc, `${where}.order`)
      }
      if ('events' in exp) expectEvents(events, exp.events as Doc[], where)
    }
  })
  expectEvents(produced, c.expect, `${c.name} / all events`)
  const final = c.finalState
  if (!approx(engine.balance, final.balance)) throw new Error(`${c.name}: balance ${engine.balance} != ${final.balance}`)
  if (engine.clock !== final.clock) throw new Error(`${c.name}: clock ${engine.clock} != ${final.clock}`)
  const orders = [...engine.orders.values()] as unknown as Doc[]
  const trades = [...engine.trades.values()] as unknown as Doc[]
  for (const [kind, actual, expected] of [
    ['orders', orders, final.orders],
    ['trades', trades, final.trades]
  ] as const) {
    if (actual.length !== expected.length) throw new Error(`${c.name}: ${kind} count ${actual.length} != ${expected.length}`)
    actual.forEach((a, i) => {
      const e = expected[i]
      const ak = Object.keys(a).sort()
      const ek = Object.keys(e).sort()
      if (ak.join() !== ek.join()) throw new Error(`${c.name}: ${kind} keys ${ak} != ${ek}`)
      expectSubset(a, e, `${c.name}.${kind}[${e.id}]`)
    })
  }
}

describe('engine parity with wdashboard-server (fixtures/engine_cases.json)', () => {
  test('the fixture is the generated file', () => {
    expect(doc.cases.length).toBeGreaterThan(20)
    expect(String((cases as { $comment: string }).$comment)).toContain('GENERATED')
  })
  for (const c of doc.cases) {
    test(c.name, () => {
      runCase(c, doc.symbol, doc.spread)
    })
  }
})

describe('engine state', () => {
  test('round-trips through toState/fromState, ids continuing', () => {
    const engine = new Engine(10_000)
    engine.onQuote({ symbol: 'x', time: 1, bid: 1, ask: 1.0002 })
    engine.submit({ symbol: 'x', side: 'buy', type: 'market', units: 100 })
    engine.submit({ symbol: 'x', side: 'sell', type: 'limit', units: 100, price: 1.01 })
    const copy = Engine.fromState(JSON.parse(JSON.stringify(engine.toState())))
    expect(copy.toState()).toEqual(engine.toState())
    const { order } = copy.submit({ symbol: 'x', side: 'buy', type: 'market', units: 1 })
    expect(order.id).toBe('o4')
  })
})
