import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SimEvent, SimTrade } from './api'
import type { InstrumentInfo } from './instrument'

// exits.ts -> format.ts -> symbols.ts -> config.ts reads `window` at import (as levels.test.ts).
installWindow()
const {
  breakevenReadout,
  closeReasonWords,
  exitText,
  exitUnitRefusal,
  labelValue,
  managementRows,
  milestoneLabel,
  milestoneNotice,
  milestonesReadout,
  milestoneValues,
  parseBreakeven,
  parseDistance,
  parseMilestones,
  parseTrail,
  stepExitText,
  toggleMilestone,
  trailReadout,
  usableExitUnit,
  wilderAtr
} = await import('./exits')
type ExitBasis = import('./exits').ExitBasis

const EURUSD: InstrumentInfo = { precision: 5, pipSize: 0.0001, assetClass: 'forex', marginRate: 0.0333, unitsPrecision: 0, timezone: 'America/New_York' }
const SPX: InstrumentInfo = { precision: 1, pipSize: null, assetClass: 'cfd', marginRate: 0.05, unitsPrecision: 1, timezone: 'America/New_York' }

/** A long at 1.10020 with a 20-pip stop, on a chart whose ATR is 15 pips. */
const LONG: ExitBasis = { side: 'buy', entry: 1.1002, risk: 0.002, atr: { value: 0.0015, period: 14, interval: '1H' }, info: EURUSD }
const SHORT: ExitBasis = { ...LONG, side: 'sell', entry: 1.1 }

function trade(over: Partial<SimTrade> = {}): SimTrade {
  return {
    id: 't2',
    symbol: 'oanda:EURUSD',
    side: 'buy',
    units: 10_000,
    entryPrice: 1.1002,
    openedAt: 1,
    orderId: 'o1',
    stopLoss: 1.0982,
    takeProfit: null,
    closedAt: null,
    closePrice: null,
    closeReason: null,
    realizedPnl: null,
    label: null,
    trailingStop: null,
    breakeven: null,
    milestones: [],
    stopMovedBy: null,
    ...over
  }
}

describe('units', () => {
  test('each unit says why it cannot state a distance', () => {
    expect(exitUnitRefusal('pips', LONG)).toBeNull()
    expect(exitUnitRefusal('pips', { ...LONG, info: SPX })).toContain('pips')
    expect(exitUnitRefusal('r', { ...LONG, risk: null })).toContain('stop loss')
    expect(exitUnitRefusal('atr', { ...LONG, atr: null })).toContain('ATR')
    expect(exitUnitRefusal('percent', { ...LONG, entry: null })).toContain('price')
    expect(usableExitUnit('r', { ...LONG, risk: null })).toBe('pips')
    expect(usableExitUnit('pips', { ...LONG, info: SPX })).toBe('price')
  })

  test('a field number becomes a price distance, and back', () => {
    expect(parseDistance('20', 'pips', LONG, 'x')).toBeCloseTo(0.002, 12)
    expect(parseDistance('0.0015', 'price', LONG, 'x')).toBe(0.0015)
    expect(parseDistance('0.1', 'percent', LONG, 'x')).toBeCloseTo(0.0011002, 12)
    expect(parseDistance('2', 'atr', LONG, 'x')).toBeCloseTo(0.003, 12)
    expect(parseDistance('1.5', 'r', LONG, 'x')).toBeCloseTo(0.003, 12)
    expect(parseDistance('', 'pips', LONG, 'x')).toBeNull()
    expect(() => parseDistance('-1', 'pips', LONG, 'The step')).toThrow('The step must be positive')
    expect(() => parseDistance('0', 'pips', LONG, 'The step')).toThrow('more than zero')
    expect(parseDistance('0', 'pips', LONG, 'x', { zero: true })).toBe(0)
    expect(parseDistance('−5', 'pips', LONG, 'x', { negative: true })).toBeCloseTo(-0.0005, 12)
    expect(() => parseDistance('1', 'r', { ...LONG, risk: null }, 'x')).toThrow('stop loss')
    expect(exitText(0.003, 'pips', LONG)).toBe('30.0')
    expect(exitText(0.003, 'atr', LONG)).toBe('2')
    expect(exitText(0.003, 'r', LONG)).toBe('1.5')
    expect(exitText(0.003, 'r', { ...LONG, risk: null })).toBe('')
  })

  test('steps move on the unit grid and start from a default', () => {
    expect(stepExitText('', 'pips', EURUSD, 1, false, 10)).toBe('10.0')
    expect(stepExitText('10.0', 'pips', EURUSD, 1, false, 10)).toBe('11.0')
    expect(stepExitText('10.0', 'pips', EURUSD, -1, true, 10, 0.1)).toBe('0.1')
    expect(stepExitText('1', 'r', EURUSD, 1, false, 1)).toBe('1.25')
  })
})

describe('the three fields', () => {
  test('a trail: its distance, where it starts and its step, all in its unit', () => {
    expect(parseTrail({ distance: '', start: '10', step: '2' }, 'pips', LONG)).toBeNull()
    const t = parseTrail({ distance: '20', start: '10', step: '2' }, 'pips', LONG)
    expect(t?.distance).toBeCloseTo(0.002, 12)
    expect(t?.activation).toBeCloseTo(0.001, 12)
    expect(t?.step).toBeCloseTo(0.0002, 12)
    const r = parseTrail({ distance: '1', start: '0', step: '' }, 'r', LONG)
    expect(r).toEqual({ distance: 0.002, activation: 0, step: null })
    expect(() => parseTrail({ distance: '20', start: '-1', step: '' }, 'pips', LONG)).toThrow('Where the trail starts must be positive')
  })

  test('a breakeven: its trigger and what it locks in, which must be less', () => {
    expect(parseBreakeven({ trigger: '', lock: '' }, 'r', LONG)).toBeNull()
    expect(parseBreakeven({ trigger: '1', lock: '' }, 'r', LONG)).toEqual({ trigger: 0.002, offset: 0 })
    const b = parseBreakeven({ trigger: '15', lock: '1' }, 'pips', LONG)
    expect(b?.trigger).toBeCloseTo(0.0015, 12)
    expect(b?.offset).toBeCloseTo(0.0001, 12)
    expect(parseBreakeven({ trigger: '10', lock: '-2' }, 'pips', LONG)?.offset).toBeCloseTo(-0.0002, 12)
    expect(() => parseBreakeven({ trigger: '10', lock: '10' }, 'pips', LONG)).toThrow('less than the trigger')
  })

  test('milestones: a list of signed multiples, sorted, deduplicated and labelled', () => {
    expect(milestoneValues('1, 2;3  -0.5')).toEqual([1, 2, 3, -0.5])
    const ms = parseMilestones('2, 1, −0.5, 1', 'r', LONG)
    expect(ms.map((m) => m.label)).toEqual(['−0.5R', '+1R', '+2R'])
    expect(ms[0].distance).toBeCloseTo(-0.001, 12)
    expect(ms[2].distance).toBeCloseTo(0.004, 12)
    expect(parseMilestones('', 'r', LONG)).toEqual([])
    expect(() => parseMilestones('1, 0', 'r', LONG)).toThrow('zero')
    expect(() => parseMilestones('1, x', 'r', LONG)).toThrow('numbers')
    expect(() => parseMilestones('1', 'r', { ...LONG, risk: null })).toThrow('stop loss')
    expect(milestoneLabel(20, 'pips', EURUSD)).toBe('+20.0p')
    expect(milestoneLabel(1.5, 'atr', EURUSD)).toBe('+1.5 ATR')
    expect(milestoneLabel(-0.25, 'percent', EURUSD)).toBe('−0.25%')
  })

  test("a milestone's label gives back the number as stated, in its own unit only", () => {
    expect(labelValue('+2R', 'r')).toBe(2)
    expect(labelValue('−0.5R', 'r')).toBe(-0.5)
    expect(labelValue('+20.0p', 'pips')).toBe(20)
    expect(labelValue('+1.5 ATR', 'atr')).toBe(1.5)
    expect(labelValue('+2R', 'pips')).toBeNull()
    expect(labelValue(null, 'r')).toBeNull()
    expect(labelValue('spread', 'r')).toBeNull()
  })

  test('a preset chip adds its multiple, and takes it out again', () => {
    expect(toggleMilestone('', 1)).toBe('1')
    expect(toggleMilestone('1', 3)).toBe('1, 3')
    expect(toggleMilestone('3, 1, 2', 2)).toBe('1, 3')
  })
})

describe('readouts', () => {
  test('a trail says where the stop goes now, where it starts and its step', () => {
    const now = trailReadout({ distance: 0.002, activation: null, step: null }, 'pips', LONG, 1.1)
    expect(now.map((p) => p.text)).toEqual(['stop 1.09800 now'])
    const later = trailReadout({ distance: 0.003, activation: 0.002, step: 0.0005 }, 'atr', LONG, 1.1)
    expect(later.map((p) => p.text)).toEqual(['30.0p', 'from 1.10220', 'steps 5.0p'])
    expect(trailReadout({ distance: 0.002 }, 'pips', LONG, null).map((p) => p.text)).toEqual(['from the fill'])
    // A short trails above.
    expect(trailReadout({ distance: 0.002 }, 'pips', SHORT, 1.1002).map((p) => p.text)).toEqual(['stop 1.10220 now'])
    // Beside a tighter stop the trail does nothing until the best price is its distance past it.
    expect(trailReadout({ distance: 0.0021 }, 'pips', LONG, 1.1, 1.0982).map((p) => p.text)).toEqual(['takes over 1.10030'])
    expect(trailReadout({ distance: 0.001 }, 'pips', LONG, 1.1, 1.0982).map((p) => p.text)).toEqual(['stop 1.09900 now'])
    expect(trailReadout({ distance: 0.001, activation: 0.003 }, 'pips', LONG, 1.1, 1.0982).map((p) => p.text)).toEqual(['from 1.10320'])
  })

  test('a breakeven and the milestones read out their prices', () => {
    expect(breakevenReadout({ trigger: 0.002, offset: 0.0001 }, LONG).map((p) => p.text)).toEqual(['at 1.10220', 'stop to +1.0p'])
    expect(breakevenReadout({ trigger: 0.002, offset: 0 }, SHORT).map((p) => p.text)).toEqual(['at 1.09800', 'stop to the entry'])
    expect(milestonesReadout([{ distance: -0.001 }, { distance: 0.002 }], LONG).map((p) => [p.text, p.tone])).toEqual([
      ['1.09920', 'down'],
      ['1.10220', 'up']
    ])
  })

  test("a working trade's management is three rows, reached milestones ticked", () => {
    const rows = managementRows(
      trade({
        trailingStop: { distance: 0.002, activation: 0.001, step: null, best: 1.103 },
        breakeven: { trigger: 0.0015, offset: 0.0001, done: true },
        milestones: [
          { distance: 0.002, label: '+1R', reachedAt: 5, price: 1.1022 },
          { distance: 0.004, label: '+2R', reachedAt: null, price: null }
        ]
      }),
      EURUSD
    )
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ['Trailing', '20.0p · from +10.0p'],
      ['Breakeven', 'at +15.0p +1.0p ✓'],
      ['Notify at', '+1R ✓ · +2R']
    ])
    expect(managementRows(trade(), EURUSD)).toEqual([])
  })

  test('a milestone reached reads as the server words it, with the pips the client knows', () => {
    const event: SimEvent = { kind: 'milestone', time: 9, orderId: null, tradeId: 't2', price: 1.1042, reason: '+2R' }
    const { title, body } = milestoneNotice(trade(), event, EURUSD)
    expect(title).toBe('EURUSD long 10K reached +2R')
    expect(body).toBe('At 1.10420 (entry 1.10020) · +40.0p · +40.00')
    const unlabelled = milestoneNotice(trade({ side: 'sell', entryPrice: 1.1 }), { ...event, price: 1.101, reason: null }, EURUSD)
    expect(unlabelled.title).toBe('EURUSD short 10K reached −10.0p')
  })
})

describe('close reasons', () => {
  test('one naming everywhere: the reason in History and the popup, the event on the card', () => {
    const cases: Array<[Pick<SimTrade, 'closeReason' | 'stopMovedBy'>, string, string]> = [
      [{ closeReason: 'stop_loss', stopMovedBy: null }, 'Stop loss', 'Stop loss hit'],
      [{ closeReason: 'stop_loss', stopMovedBy: 'trail' }, 'Trailing stop', 'Trailing stop hit'],
      [{ closeReason: 'stop_loss', stopMovedBy: 'breakeven' }, 'Breakeven stop', 'Breakeven stop hit'],
      [{ closeReason: 'take_profit', stopMovedBy: 'trail' }, 'Take profit', 'Take profit hit'],
      [{ closeReason: 'flatten' }, 'Flattened', 'Flattened'],
      [{ closeReason: 'manual' }, 'Closed by hand', 'Closed by hand']
    ]
    for (const [trade, reason, event] of cases) {
      expect(closeReasonWords(trade)).toBe(reason)
      expect(closeReasonWords(trade, true)).toBe(event)
    }
  })
})

describe('ATR', () => {
  test("Wilder's: seeded by the mean of the first true ranges, then smoothed", () => {
    const flat = Array.from({ length: 20 }, () => ({ high: 1.101, low: 1.1, close: 1.1005 }))
    expect(wilderAtr(flat, 14)).toBeCloseTo(0.001, 12)
    expect(wilderAtr(flat.slice(0, 14), 14)).toBeNull()
    // A gap makes the true range the distance from the previous close.
    const gap = [{ high: 1.1, low: 1.1, close: 1.1 }, { high: 1.104, low: 1.103, close: 1.1035 }]
    expect(wilderAtr(gap, 1)).toBeCloseTo(0.004, 12)
    const bars = [
      { high: 2, low: 1, close: 1.5 },
      { high: 3, low: 2, close: 2.5 },
      { high: 2.6, low: 2.4, close: 2.5 },
      { high: 2.5, low: 1.5, close: 2 }
    ]
    // TRs 1.5, 0.2, 1.0; seed (1.5 + 0.2) / 2 = 0.85; then (0.85 + 1.0) / 2 = 0.925.
    expect(wilderAtr(bars, 2)).toBeCloseTo(0.925, 12)
  })
})
