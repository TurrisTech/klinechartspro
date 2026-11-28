import { describe, expect, test } from 'bun:test'
import {
  defaultRule,
  defaultRuleSource,
  freshSourceId,
  normalInstrument,
  RANK_TIMEFRAMES,
  rank85Strategy,
  ruleStrategy,
  ruleWithEntry,
  ruleWithRoot,
  ruleWithStep,
  strategyCopy,
  strategyProblems,
  utcDay,
  utcDayStart,
  withHoldoutKind,
  withoutRule,
  withoutSource,
  withRuleAdded,
  withRuleCopied,
  withSourceAdded,
  withWindowKind
} from './model'

// THE EDITS (model.ts), pure: what the editor's chips, root picker and rule buttons and the page
// header's instrument, window and holdout do to a strategy -- each a new strategy or rule out,
// the one handed in untouched.

/** 2026-03-13 15:30 UTC. */
const NOW = Date.UTC(2026, 2, 13, 15, 30)

/** `make()`'s result and a copy of it: one to edit, one to compare it with afterwards. */
function twice<T>(make: () => T): [T, T] {
  const made = make()
  return [made, structuredClone(made)]
}

describe('the header', () => {
  test('an instrument is vendor:TICKER, a bare ticker an OANDA one', () => {
    expect(normalInstrument(' eurusd ')).toBe('oanda:EURUSD')
    expect(normalInstrument('Coinbase:btc-usd')).toBe('coinbase:BTC-USD')
    expect(normalInstrument('schwab:$spx')).toBe('schwab:$SPX')
    // A leading colon names no vendor.
    expect(normalInstrument(':x')).toBe('oanda::X')
  })

  test('a window’s day is a UTC day', () => {
    expect(utcDay(NOW)).toBe('2026-03-13')
    expect(utcDayStart('2026-03-13')).toBe(Date.UTC(2026, 2, 13))
    expect(utcDayStart('')).toBeNull()
    expect(utcDayStart('13/03/2026')).toBeNull()
  })

  test('the last N days as dates: N - 1 days ago through today, and back', () => {
    const [s, before] = twice(() => rank85Strategy(0))
    const range = withWindowKind(s, 'range', NOW)
    expect(range.window).toEqual({ kind: 'range', from: Date.UTC(2026, 1, 12), to: Date.UTC(2026, 2, 14) })
    expect(s).toEqual(before)
    expect(withWindowKind(range, 'days', NOW).window).toEqual({ kind: 'days', days: 30 })
    // A window of the kind asked for stays as it is; a range is never shorter than a day.
    expect(withWindowKind(s, 'days', NOW)).toBe(s)
    expect(withWindowKind({ ...s, window: { kind: 'range', from: NOW, to: NOW } }, 'days', NOW).window).toEqual({ kind: 'days', days: 1 })
  })

  test('a holdout: the last 30%, from the day 30% back from the end, or none', () => {
    const [s, before] = twice(() => rank85Strategy(0))
    const window = { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 0, 11, 12) }
    expect(withHoldoutKind(s, 'percent', window).holdout).toEqual({ kind: 'percent', percent: 30 })
    // 30% of 10.5 days back from noon on the 11th is 08:24 on the 8th: from that day.
    expect(withHoldoutKind(s, 'from', window).holdout).toEqual({ kind: 'from', at: Date.UTC(2026, 0, 8) })
    expect(withHoldoutKind({ ...s, holdout: { kind: 'percent', percent: 20 } }, '', window).holdout).toBeNull()
    expect(s).toEqual(before)
  })

  test('a copy is a new strategy, made now, sharing nothing', () => {
    const s = rank85Strategy(0)
    const copy = strategyCopy(s, NOW)
    expect(copy.id).not.toBe(s.id)
    expect([copy.name, copy.createdAt, copy.updatedAt]).toEqual(['AREV21 rank 85 rules copy', NOW, NOW])
    expect(copy.rules).toEqual(s.rules)
    copy.rules[0].steps.pop()
    expect(s.rules[0].steps).toHaveLength(9)
  })
})

describe('a rule’s timeframes', () => {
  test('a new root keeps the steps still under it, and the entries among them', () => {
    const [rule, before] = twice(() => defaultRule('long', '1D', RANK_TIMEFRAMES, 'rank85', 'long1D'))
    const on1h = ruleWithRoot(rule, '1h', RANK_TIMEFRAMES)
    expect([on1h.root, on1h.steps, on1h.entryOn]).toEqual(['1h', ['3m', '5m', '15m', '20m', '30m'], ['3m', '5m']])
    expect(rule).toEqual(before)
    // Nothing under 3m: no steps, and the root is the entry.
    const on3m = ruleWithRoot(rule, '3m', RANK_TIMEFRAMES)
    expect([on3m.steps, on3m.entryOn]).toEqual([[], ['3m']])
  })

  test('with none of its steps under the new root, it steps through all of them', () => {
    const rule = { ...defaultRule('long', '1D', RANK_TIMEFRAMES, 'rank85', 'long1D'), steps: ['4h', '8h'], entryOn: ['4h'] }
    const moved = ruleWithRoot(rule, '1h', RANK_TIMEFRAMES)
    expect(moved.steps).toEqual(['3m', '5m', '15m', '20m', '30m'])
    expect(moved.entryOn).toEqual(['3m', '5m'])
  })

  test('a rule with no steps keeps none, and enters on its new root', () => {
    const [rule] = ruleStrategy(0).rules
    const moved = ruleWithRoot(rule, '4h', RANK_TIMEFRAMES)
    expect([moved.root, moved.steps, moved.entryOn]).toEqual(['4h', [], ['4h']])
  })

  test('a step off takes it out of the entries; the entries fall back to the shortest step', () => {
    const [rule, before] = twice(() => defaultRule('long', '1D', ['3m', '5m', '15m', '1h', '4h'], 'rank85', 'long1D'))
    const no5m = ruleWithStep(rule, '5m', false)
    expect([no5m.steps, no5m.entryOn]).toEqual([['3m', '15m', '1h', '4h'], ['3m']])
    const no3m = ruleWithStep(no5m, '3m', false)
    expect(no3m.entryOn).toEqual(['15m'])
    // On again, in its place; the entries stand.
    const back = ruleWithStep(no3m, '3m', true)
    expect([back.steps, back.entryOn]).toEqual([['3m', '15m', '1h', '4h'], ['15m']])
    // The last step off: the root's signals are the entries.
    let bare = rule
    for (const tf of rule.steps) bare = ruleWithStep(bare, tf, false)
    expect([bare.steps, bare.entryOn]).toEqual([[], ['1D']])
    expect(rule).toEqual(before)
  })

  test('an entry on or off, shortest first', () => {
    const [rule, before] = twice(() => defaultRule('long', '1D', RANK_TIMEFRAMES, 'rank85', 'long1D'))
    expect(ruleWithEntry(rule, '1h', true).entryOn).toEqual(['3m', '5m', '1h'])
    expect(ruleWithEntry(ruleWithEntry(rule, '1h', true), '15m', true).entryOn).toEqual(['3m', '5m', '15m', '1h'])
    expect(ruleWithEntry(rule, '5m', false).entryOn).toEqual(['3m'])
    expect(rule).toEqual(before)
  })
})

describe('rules and signals added, copied and removed', () => {
  test('a new rule takes the overlay’s next root free on its side, among those offered', () => {
    const [s, before] = twice(() => rank85Strategy(0))
    const added = withRuleAdded(s, 'long', RANK_TIMEFRAMES)
    const rule = added.rules.at(-1)
    expect(rule && [rule.id, rule.direction, rule.root, rule.follows, rule.source]).toEqual(['long8h', 'long', '8h', 'bottom', 'rank85'])
    expect(rule?.steps).toEqual(['3m', '5m', '15m', '20m', '30m', '1h', '2h', '4h'])
    // The short side has its own: its 1D is taken, the long 8h is not its.
    expect(withRuleAdded(added, 'short', RANK_TIMEFRAMES).rules.at(-1)?.root).toBe('8h')
    // The other rules are the same objects; the strategy handed in is untouched.
    expect(added.rules.slice(0, 2)).toEqual(s.rules)
    expect(added.rules[0]).toBe(s.rules[0])
    expect(s).toEqual(before)
  })

  test('with every root taken the longest offered, with none offered 1h; a rule event has no steps', () => {
    let s = rank85Strategy(0)
    for (let i = 0; i < 4; i++) s = withRuleAdded(s, 'long', ['5m', '1h', '4h'])
    expect(s.rules.filter((r) => r.direction === 'long').map((r) => r.root)).toEqual(['1D', '4h', '1h', '4h', '4h'])
    expect(withRuleAdded(rank85Strategy(0), 'long', []).rules.at(-1)?.root).toBe('1h')
    const events = withRuleAdded(ruleStrategy(0), 'long', RANK_TIMEFRAMES).rules.at(-1)
    expect(events && [events.root, events.steps, events.entryOn, events.source]).toEqual(['1D', [], ['1D'], 'rsi'])
  })

  test('a copy goes right after its rule, under an id of its own; a rule removed is gone', () => {
    const [s, before] = twice(() => rank85Strategy(0))
    const copied = withRuleCopied(s, s.rules[0])
    expect(copied.rules.map((r) => r.id)).toEqual(['long1D', 'long1D_2', 'short1D'])
    copied.rules[1].steps.pop()
    expect(copied.rules[0].steps).toHaveLength(9)
    expect(withoutRule(copied, copied.rules[1]).rules.map((r) => r.id)).toEqual(['long1D', 'short1D'])
    expect(s).toEqual(before)
  })

  test('a signal added under a fresh id, and removed', () => {
    const [s, before] = twice(() => rank85Strategy(0))
    expect(freshSourceId(s, 'sig')).toBe('sig1')
    const added = withSourceAdded(s, defaultRuleSource(freshSourceId(s, 'rule')))
    expect(added.sources.map((x) => [x.id, x.kind, x.title])).toEqual([
      ['rank85', 'published', 'AREV21 outlier rank 85'],
      ['rule1', 'rule', 'Rule event']
    ])
    expect(freshSourceId(added, 'rule')).toBe('rule2')
    expect(strategyProblems(added)).toEqual([])
    // A signal its rules follow, removed: they name it still, which is a problem.
    const removed = withoutSource(added, 0)
    expect(removed.sources.map((x) => x.id)).toEqual(['rule1'])
    expect(strategyProblems(removed).map((p) => p.where)).toContain('Long · 1D · signal')
    expect(s).toEqual(before)
  })

  test('a rule event’s default is the RSI(14) crosses the rule-event strategy reads', () => {
    const event = defaultRuleSource('rsi')
    const [preset] = ruleStrategy(0).sources
    expect(preset.kind === 'rule' && [preset.top, preset.bottom, preset.price]).toEqual([event.top, event.bottom, event.price])
  })
})
