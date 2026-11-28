import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimAccount, SimQuote } from './api'
import type { InstrumentInfo } from './instrument'
import type { OrderFields, OrderMarket, OrderPlan } from './order'
import type { TradePrefs } from './prefs'

// order.ts -> format.ts -> symbols.ts -> config.ts reads `window` at import: stub it, then import.
installWindow()
const {
  atRatio,
  atTrailPreset,
  breakevenWarning,
  draftOf,
  enteredSize,
  entryAt,
  isSendable,
  notifyValue,
  orderRequest,
  planFigures,
  planOrder,
  problemSlot,
  protectModeFor,
  ratioRefusal,
  restateDistance,
  restateMilestones,
  restingProblem,
  riskPercentOf,
  riskStopLevel,
  riskStopRefusal,
  sendRefusal,
  sizeAs,
  sizeRefusal,
  steppedSize,
  targetAt,
  trailPresetDistance,
  usableSizeMode
} = await import('./order')
const { pricingContext } = await import('./metrics')
const { DEFAULT_PREFS } = await import('./prefs')

const KEY = 'oanda:EURUSD'
const ACCOUNT: SimAccount = { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 }
const EURUSD: InstrumentInfo = { precision: 5, pipSize: 0.0001, assetClass: 'forex', marginRate: 0.0333, unitsPrecision: 0, timezone: 'America/New_York' }
const SPX: InstrumentInfo = { precision: 1, pipSize: null, assetClass: 'cfd', marginRate: null, unitsPrecision: 1, timezone: 'America/New_York' }
const QUOTE: SimQuote = { time: 0, bid: 1.1, ask: 1.1002 }

function fields(over: Partial<OrderFields> = {}): OrderFields {
  return {
    side: 'buy',
    type: 'market',
    price: '',
    stopLoss: '',
    takeProfit: '',
    trail: { distance: '', start: '', step: '' },
    breakeven: { trigger: '', lock: '' },
    notify: '',
    note: '',
    ...over
  }
}

function market(prefs: Partial<TradePrefs> = {}, over: Partial<OrderMarket> = {}): OrderMarket {
  const info = over.info ?? EURUSD
  const quote = 'quote' in over ? over.quote : QUOTE
  return {
    info,
    quote,
    ctx: pricingContext(KEY, info, ACCOUNT, quote, quote ? { [KEY]: quote } : {}),
    prefs: { ...DEFAULT_PREFS, ...prefs },
    ready: true,
    atr: { value: 0.0015, period: 14, interval: '1H' },
    ...over
  }
}

const plan = (f: Partial<OrderFields> = {}, prefs: Partial<TradePrefs> = {}, over: Partial<OrderMarket> = {}): OrderPlan =>
  planOrder(fields(f), market(prefs, over))

describe('planOrder', () => {
  test('a market buy fills at the ask, sized in units, its levels in pips from there', () => {
    const p = plan({ stopLoss: '20', takeProfit: '40' })
    expect(p.entry).toBe(1.1002)
    expect(p.units).toBe(10_000)
    expect(p.stop).toBe(1.0982)
    expect(p.target).toBe(1.1042)
    expect(p.problem).toBeNull()
    expect(p.exits.risk).toBeCloseTo(0.002, 10)
  })

  test('a limit needs a price, on the side it rests on', () => {
    expect(plan({ type: 'limit' }).problems.price).toBe('A limit order needs a price')
    const wrong = plan({ type: 'limit', price: '1.1010' })
    expect(wrong.price).toBe(1.101)
    expect(wrong.problems.price).toBe('A buy limit must be below the ask (1.10020)')
    const ok = plan({ type: 'limit', price: '1.0990', stopLoss: '10' })
    expect(ok.entry).toBe(1.099)
    expect(ok.stop).toBe(1.098)
    expect(ok.problem).toBeNull()
  })

  test('without a quote the general problem says why, and it comes first', () => {
    const p = plan({ type: 'limit' }, {}, { quote: undefined })
    expect(p.problems.general).toBe('No quote yet')
    expect(p.problem).toBe('No quote yet')
    expect(plan({}, {}, { quote: undefined, ready: false }).problem).toBe('Connecting…')
  })

  test('a stop on the wrong side of the entry is refused under the stop', () => {
    const p = plan({ stopLoss: '1.1010', takeProfit: '1.1050' }, { protectMode: 'price' })
    expect(p.problems.stop).toBe('The stop loss must be below the ask')
    expect(p.problem).toBe(p.problems.stop ?? null)
    expect(problemSlot(p.problems)).toBe('stop')
  })

  test('sizing by risk takes the units from the stop, floored so the loss never exceeds it', () => {
    const p = plan({ stopLoss: '20' }, { sizeMode: 'risk', riskPercent: 1 })
    // 1% of 10,000 USD over 20 pips: 100 / 0.0020.
    expect(p.units).toBe(50_000)
    expect(p.problem).toBeNull()
    expect(plan({}, { sizeMode: 'risk' }).problems.size).toBe('Sizing by risk needs a stop loss')
    expect(plan({ stopLoss: '20' }, { sizeMode: 'riskAmount', riskAmount: 50 }).units).toBe(25_000)
  })

  test('lots are 100,000 units; value and margin convert through the account currency', () => {
    expect(plan({}, { sizeMode: 'lots', lots: 0.25 }).units).toBe(25_000)
    expect(plan({}, { sizeMode: 'notional', notional: 11_001 }).units).toBe(10_000)
    expect(plan({}, { sizeMode: 'units', units: 0.4 }).problems.size).toBeUndefined()
  })

  test('% of balance is not a way to state the stop while the size comes from it', () => {
    expect(protectModeFor({ ...DEFAULT_PREFS, protectMode: 'percent' }, market().ctx)).toBe('percent')
    expect(protectModeFor({ ...DEFAULT_PREFS, protectMode: 'percent', sizeMode: 'risk' }, market().ctx)).toBe('pips')
    expect(protectModeFor({ ...DEFAULT_PREFS, protectMode: 'pips' }, market({}, { info: SPX }).ctx)).toBe('price')
  })

  test('exit management is measured from the entry, R the stop distance', () => {
    const p = plan(
      { stopLoss: '20', trail: { distance: '15', start: '', step: '' }, breakeven: { trigger: '1', lock: '' }, notify: '1, 2' },
      { trailUnit: 'pips', breakevenUnit: 'r', notifyUnit: 'r' }
    )
    expect(p.trail?.distance).toBeCloseTo(0.0015, 10)
    expect(p.breakeven?.trigger).toBeCloseTo(0.002, 10)
    expect(p.milestones.map((m) => m.label)).toEqual(['+1R', '+2R'])
    expect(plan({ trail: { distance: 'x', start: '', step: '' } }).problems.trail).toBe('The trailing distance: not a number')
  })
})

describe('sending', () => {
  test('the request carries the plan, the side, the type and the note as typed', () => {
    const f = fields({ stopLoss: '20', note: '  breakout  ' })
    const p = planOrder(f, market())
    expect(sendRefusal(p)).toBeNull()
    if (!isSendable(p)) throw new Error('expected a sendable plan')
    expect(orderRequest(KEY, f, p)).toEqual({
      symbol: KEY,
      side: 'buy',
      type: 'market',
      units: 10_000,
      price: undefined,
      stopLoss: 1.0982,
      takeProfit: undefined,
      label: 'breakout',
      trailingStop: undefined,
      breakeven: undefined,
      milestones: undefined
    })
  })

  test('a plan with a problem, or no size, is not sent', () => {
    const p = plan({ type: 'stop' })
    expect(isSendable(p)).toBe(false)
    expect(sendRefusal(p)).toBe('A stop order needs a price')
    expect(sendRefusal({ ...plan(), units: null })).toBe('Nothing to send')
  })

  test('the draft is the plan with an entry; a risk-sized one carries its share of the balance', () => {
    expect(draftOf(KEY, fields(), plan({}, {}, { quote: undefined }), DEFAULT_PREFS)).toBeNull()
    const prefs = { ...DEFAULT_PREFS, sizeMode: 'riskAmount' as const, riskAmount: 200 }
    const draft = draftOf(KEY, fields({ stopLoss: '20' }), plan({ stopLoss: '20' }, prefs), prefs)
    expect(draft).toMatchObject({ symbol: KEY, side: 'buy', type: 'market', entry: 1.1002, stop: 1.0982, target: null, problem: null })
    expect(draft?.riskPercent).toBe(2)
    expect(riskPercentOf(DEFAULT_PREFS, plan())).toBeNull()
  })

  test('the figures are the size rows, then R:R once both levels are set', () => {
    const rows = planFigures('buy', plan({ stopLoss: '20', takeProfit: '40' }))
    expect(rows.map((r) => r.label)).toContain('Size')
    expect(rows.at(-1)).toEqual({ label: 'R:R', value: '2.00' })
    expect(planFigures('buy', plan({ stopLoss: '20' })).some((r) => r.label === 'R:R')).toBe(false)
  })
})

describe('the price', () => {
  test('a dragged entry becomes a limit or a stop by the side of the market it lands on', () => {
    expect(entryAt('buy', 1.0995, QUOTE, EURUSD)).toEqual({ type: 'limit', price: '1.09950' })
    expect(entryAt('buy', 1.1010, QUOTE, EURUSD)).toEqual({ type: 'stop', price: '1.10100' })
    expect(entryAt('sell', 1.0995, QUOTE, EURUSD)).toEqual({ type: 'stop', price: '1.09950' })
    expect(entryAt('buy', 1.100204, QUOTE, EURUSD)).toEqual({ type: 'market', price: '' })
    expect(entryAt('buy', 1.1, undefined, EURUSD)).toBeNull()
  })

  test('a resting price that is missing or refused is a problem', () => {
    expect(restingProblem(fields({ type: 'limit' }), QUOTE, 5)).toBe('no price')
    expect(restingProblem(fields({ type: 'limit', price: '1.1010' }), QUOTE, 5)).toBe('A buy limit must be below the ask (1.10020)')
    expect(restingProblem(fields({ type: 'limit', price: '1.0990' }), QUOTE, 5)).toBeNull()
  })
})

describe('the size', () => {
  test('lots are a forex convention, and margin needs a rate', () => {
    expect(sizeRefusal('lots', SPX)).toBe('Lots are a forex convention')
    expect(sizeRefusal('margin', SPX)).toBe('No margin rate for this instrument')
    expect(sizeRefusal('margin', EURUSD)).toBeNull()
    expect(usableSizeMode({ ...DEFAULT_PREFS, sizeMode: 'lots' }, SPX)).toBe('units')
    expect(usableSizeMode({ ...DEFAULT_PREFS, sizeMode: 'lots' }, EURUSD)).toBe('lots')
  })

  test('a typed size within its cap, and a step snapped to the grid', () => {
    expect(enteredSize('2.5', 'risk')).toBe(2.5)
    expect(enteredSize('150', 'risk')).toBeNull()
    expect(enteredSize('0', 'units')).toBeNull()
    const prefs = { ...DEFAULT_PREFS, units: 10_250 }
    expect(steppedSize('units', prefs, EURUSD, 1, false)).toBe(11_000)
    expect(steppedSize('units', prefs, EURUSD, -1, false)).toBe(10_000)
    expect(steppedSize('units', prefs, EURUSD, 1, true)).toBe(20_000)
    expect(steppedSize('units', { ...DEFAULT_PREFS, units: 1000 }, EURUSD, -1, false)).toBeNull()
    expect(steppedSize('risk', { ...DEFAULT_PREFS, riskPercent: 100 }, EURUSD, 1, false)).toBeNull()
    expect(steppedSize('units', { ...DEFAULT_PREFS, units: 1 }, SPX, 1, false)).toBe(1.1)
  })

  test("switching how the size is given carries the order's size across", () => {
    const p = plan({ stopLoss: '20' })
    expect(sizeAs('lots', 'buy', p)).toBe(0.1)
    expect(sizeAs('risk', 'buy', p)).toBe(0.2)
    expect(sizeAs('riskAmount', 'buy', p)).toBe(20)
    expect(sizeAs('notional', 'buy', p)).toBe(11_001)
    expect(sizeAs('risk', 'buy', plan())).toBeNull()
  })
})

describe('presets', () => {
  test('Risk N% puts the stop where the size loses that share, unless the size comes from the risk', () => {
    const p = plan()
    expect(riskStopRefusal(DEFAULT_PREFS, p)).toBeNull()
    expect(riskStopLevel('buy', DEFAULT_PREFS, p)).toBe(1.0902)
    const risked = { ...DEFAULT_PREFS, sizeMode: 'risk' as const }
    expect(riskStopRefusal(risked, plan({ stopLoss: '20' }, risked))).toBe('the size already comes from the risk')
    expect(riskStopLevel('buy', risked, plan({ stopLoss: '20' }, risked))).toBeNull()
  })

  test('1R/2R/3R need a stop on the right side, and light at their multiple', () => {
    expect(ratioRefusal('buy', plan())).toBe('set a stop loss first')
    const p = plan({ stopLoss: '20', takeProfit: '40' })
    expect(ratioRefusal('buy', p)).toBeNull()
    expect(targetAt('buy', p, 3)).toBe(1.1062)
    expect(atRatio('buy', p, 2)).toBe(true)
    expect(atRatio('buy', p, 1)).toBe(false)
    expect(ratioRefusal('buy', plan({ stopLoss: '1.1010' }, { protectMode: 'price' }))).toBe('the stop is past the entry')
  })

  test('the trail presets are 1R and twice the ATR; Notify at is a multiple of R in its unit', () => {
    const p = plan({ stopLoss: '20', trail: { distance: '20', start: '', step: '' } }, { trailUnit: 'pips' })
    expect(trailPresetDistance(0, p.exits)).toBeCloseTo(0.002, 10)
    expect(trailPresetDistance(1, p.exits)).toBeCloseTo(0.003, 10)
    expect(atTrailPreset(0, p)).toBe(true)
    expect(atTrailPreset(1, p)).toBe(false)
    expect(notifyValue(2, 'r', p.exits)).toBe(2)
    expect(notifyValue(2, 'pips', p.exits)).toBe(40)
    expect(notifyValue(2, 'r', plan().exits)).toBeNull()
  })

  test('a breakeven that would not tighten the stop is said, not refused', () => {
    const be = (lock: string) => plan({ stopLoss: '20', breakeven: { trigger: '10', lock } }, { breakevenUnit: 'pips' })
    expect(breakevenWarning('buy', be(''))).toEqual([])
    // Locking in 25 pips of loss puts the breakeven below a stop 20 pips under the entry.
    expect(be('-25').breakeven?.offset).toBeCloseTo(-0.0025, 10)
    expect(breakevenWarning('buy', be('-25'))).toEqual([{ text: 'the stop is already past it', tone: 'warn' }])
    expect(breakevenWarning('buy', plan({ stopLoss: '20' }))).toEqual([])
  })
})

describe('restating exits', () => {
  test('a distance keeps its size in the new unit; what is not one is kept', () => {
    const basis = plan({ stopLoss: '20' }).exits
    expect(restateDistance('20', 'pips', 'r', basis)).toBe('1')
    expect(restateDistance('-0.5', 'r', 'pips', basis, { negative: true })).toBe('-10.0')
    expect(restateDistance('abc', 'pips', 'r', basis)).toBe('abc')
    expect(restateMilestones('1, 2', 'r', 'pips', basis)).toBe('20.0, 40.0')
    expect(restateMilestones('1, x', 'r', 'pips', basis)).toBe('1, x')
  })
})
