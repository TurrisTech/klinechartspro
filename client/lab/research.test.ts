import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The research half of the lab, without a DOM: how sure a mean is, the figures a comparison
// reads, a holdout's two parts, every number a sweep can move, a basket's pooled trades, what an
// edit changed, the run history, and a strategy's round trip through a file.
installWindow()
const { meanStats, seeded } = await import('./stats')
const { figuresOf, change, FIGURE_COLUMNS, inPart } = await import('./figures')
const { exprNumbers, setExprNumber, sweepTargets, sweepValues, runSweep } = await import('./sweep')
const { FX_28, MAJORS, poolBasket, runBasket } = await import('./basket')
const { strategyChanges, describeChanges } = await import('./changes')
const { entriesCsv, tradesCsv, readStrategyFile, strategyJson, ImportError } = await import('./export')
const { RunHistory } = await import('./runs')
const { runStrategy, holdoutStart } = await import('./runner')
const { rank85Strategy, strategyProblems } = await import('./model')
const { FakeData, NOW, D, withRules } = await import('./testdata')

import type { Strategy } from './model'

const window = { from: NOW - 10 * D, to: NOW }

/** The one item `find` must find. */
function only<T>(found: T | undefined): T {
  if (found === undefined) throw new Error('not found')
  return found
}

function strategy(): Strategy {
  const s = rank85Strategy(NOW)
  withRules(s, ['4h', '1h'], ['3m', '5m', '15m', '1h', '4h'])
  return s
}

describe('how sure a mean is', () => {
  test('mean, t and a bootstrap interval that holds the mean', () => {
    const xs = [1, -0.5, 0.8, 1.2, -1, 0.3, 0.9, -0.2, 0.6, 1.1]
    const s = meanStats(xs)
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1))
    expect(s.mean).toBeCloseTo(mean, 12)
    expect(s.t).toBeCloseTo(mean / (sd / Math.sqrt(xs.length)), 12)
    const [lo, hi] = s.ci as [number, number]
    expect(lo).toBeLessThan(mean)
    expect(hi).toBeGreaterThan(mean)
  })

  test('the same sample gives the same interval: a re-run moves nothing', () => {
    const xs = Array.from({ length: 40 }, (_, i) => Math.sin(i))
    expect(meanStats(xs).ci).toEqual(meanStats([...xs]).ci)
  })

  test('noise around zero is not significant; a steady edge is', () => {
    const random = seeded(7)
    const noise = Array.from({ length: 200 }, () => random() - 0.5)
    expect(Math.abs(meanStats(noise).t as number)).toBeLessThan(2.5)
    const edge = noise.map((x) => x + 0.2)
    expect(meanStats(edge).t as number).toBeGreaterThan(4)
    expect((meanStats(edge).ci as [number, number])[0]).toBeGreaterThan(0)
  })

  test('too few to say', () => {
    expect(meanStats([]).mean).toBeNull()
    expect(meanStats([1]).t).toBeNull()
    expect(meanStats([1]).ci).toBeNull()
  })
})

describe('figures and the holdout', () => {
  test('a run splits at its holdout: the two parts add up to the whole', async () => {
    const s = strategy()
    s.holdout = { kind: 'percent', percent: 40 }
    const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
    expect(run.split).toBe(holdoutStart(s, window.from, window.to))
    expect(run.split as number).toBeCloseTo(window.to - 0.4 * (window.to - window.from), -3)
    const all = figuresOf(run)
    const fit = figuresOf(run, 'fit')
    const hold = figuresOf(run, 'holdout')
    expect(fit.entries + hold.entries).toBe(all.entries)
    expect(fit.trades + hold.trades).toBe(all.trades)
    expect(fit.entries).toBeGreaterThan(0)
    expect(hold.entries).toBeGreaterThan(0)
    expect((fit.totalR ?? 0) + (hold.totalR ?? 0)).toBeCloseTo(all.totalR ?? 0, 9)
    for (const e of run.entries) expect(inPart(e.at, e.at < (run.split as number) ? 'fit' : 'holdout', run.split)).toBe(true)
  })

  test('no holdout: everything is fitting, nothing held back', async () => {
    const run = await runStrategy(strategy(), new FakeData(), { ...window, catalogue: null, now: NOW })
    expect(run.split).toBeNull()
    expect(figuresOf(run, 'holdout').entries).toBe(0)
    expect(figuresOf(run, 'fit').entries).toBe(run.entries.length)
  })

  test('a holdout outside the window, or out of range, is a problem or nothing', () => {
    const s = strategy()
    s.holdout = { kind: 'percent', percent: 100 }
    expect(strategyProblems(s).map((p) => p.where)).toContain('Window')
    expect(holdoutStart({ holdout: { kind: 'from', at: window.from - D } }, window.from, window.to)).toBeNull()
  })

  test('a change is better or worse by the figure: a lower drawdown is better', async () => {
    const run = await runStrategy(strategy(), new FakeData(), { ...window, catalogue: null, now: NOW })
    const now = figuresOf(run)
    const dd = only(FIGURE_COLUMNS.find((c) => c.key === 'dd'))
    const avgR = only(FIGURE_COLUMNS.find((c) => c.key === 'avgR'))
    const worse = { ...now, maxDrawdown: (now.maxDrawdown ?? 0) + 0.05, avgR: (now.avgR ?? 0) - 0.1 }
    expect(change(dd, now, worse)?.sign).toBe(1)
    expect(change(avgR, now, worse)?.sign).toBe(1)
    expect(change(avgR, worse, now)?.sign).toBe(-1)
    expect(change(avgR, now, now)?.text).toBe('=')
  })
})

describe('sweeps', () => {
  test('the numbers in a condition: standing alone, not in names or strings', () => {
    expect(exprNumbers("parent.tf <= child.tf * 8").map((n) => n.value)).toEqual([8])
    expect(exprNumbers("node.tf <= tf('5m') and ind('EMA', 'ema1', '1h', 200) > 0.5").map((n) => n.value)).toEqual([200, 0.5])
    expect(exprNumbers('child.raw.p2 > 0.65').map((n) => n.value)).toEqual([0.65])
    expect(setExprNumber("ind('EMA', 'ema1', '1h', 200) > 0.5", 1, 0.55)).toBe("ind('EMA', 'ema1', '1h', 200) > 0.55")
    expect(setExprNumber('parent.tf <= child.tf * 8', 0, 6)).toBe('parent.tf <= child.tf * 6')
  })

  test("every number of the rank 85 strategy is a target, and each sets its own", () => {
    const s = strategy()
    const targets = sweepTargets(s)
    const ids = targets.map((t) => t.id)
    expect(ids).toContain('source:rank85:param:q')
    expect(ids).toContain('rule:long4h:maxStep') // the 8 of `parent.tf <= child.tf * 8`
    expect(ids).toContain('exit:stop:mult')
    expect(ids).toContain('exit:target:r')
    expect(ids).toContain('exit:time')
    expect(ids).toContain('cost:slippage')
    // A rule's longest step, by the rule.
    const eight = only(targets.find((t) => t.id === 'rule:long4h:maxStep'))
    expect(eight.value).toBe(8)
    expect(eight.label).toBe('Long · 4h · at most N× shorter a step')
    const copy = structuredClone(s)
    eight.apply(copy, 4)
    expect(copy.rules[0].maxStep).toBe(4)
    expect(s.rules[0].maxStep).toBe(8)
    // A number written in a rule's own condition.
    const withCondition = structuredClone(s)
    withCondition.rules[1].entryIf = [{ id: 'c', expr: 'node.depth >= 2', enabled: true }]
    const two = only(sweepTargets(withCondition).find((t) => t.id === 'rule:short4h:entry:0:0'))
    expect(two.label).toBe('Short · 4h · entry condition 1 · 2 in node.depth >= 2')
    const other = structuredClone(withCondition)
    two.apply(other, 3)
    expect(other.rules[1].entryIf[0].expr).toBe('node.depth >= 3')
    const q = only(targets.find((t) => t.id === 'source:rank85:param:q'))
    q.apply(copy, 0.9)
    expect(copy.sources[0].kind === 'published' && copy.sources[0].params.q).toBe(0.9)
  })

  test('values: inclusive, whole and distinct for an integer, never under the minimum', () => {
    expect(sweepValues(1, 2, 5, false, null)).toEqual([1, 1.25, 1.5, 1.75, 2])
    expect(sweepValues(2, 4, 7, true, 1)).toEqual([2, 3, 4])
    expect(sweepValues(-1, 1, 3, false, 0)).toEqual([0, 1])
  })

  test('a sweep runs a copy per value and leaves the draft alone', async () => {
    const s = strategy()
    const target = only(sweepTargets(s).find((t) => t.id === 'exit:stop:mult'))
    const data = new FakeData()
    const rows = await runSweep(s, target, [1, 2], (copy) => runStrategy(copy, data, { ...window, catalogue: null, now: NOW }), () => {}, () => false)
    expect(rows.map((r) => r.value)).toEqual([1, 2])
    expect(rows.every((r) => r.all && !r.error)).toBe(true)
    // A wider stop: the same entries, different trades.
    expect(rows[0].all?.entries).toBe(rows[1].all?.entries)
    expect(s.exits.stop?.kind === 'atr' && s.exits.stop.mult).toBe(1.5)
  })
})

describe('baskets', () => {
  test('the 28 pairs are the 8 currencies two by two, named as the market quotes them', () => {
    expect(FX_28).toHaveLength(28)
    expect(new Set(FX_28).size).toBe(28)
    for (const m of MAJORS) expect(FX_28).toContain(m)
    for (const p of ['EURGBP', 'GBPJPY', 'AUDNZD', 'CADCHF', 'CHFJPY']) expect(FX_28).toContain(p)
  })

  test('each instrument a row; the pool is every trade of them', async () => {
    const data = new FakeData()
    const rows = await runBasket(
      ['oanda:EURUSD', 'oanda:GBPUSD', 'oanda:NOPE'],
      (symbol) => (symbol === 'oanda:NOPE' ? Promise.reject(new Error('no such instrument')) : runStrategy(strategy(), data, { ...window, symbol, catalogue: null, now: NOW })),
      () => {},
      () => false,
      2
    )
    expect(rows.map((r) => r.symbol)).toEqual(['oanda:EURUSD', 'oanda:GBPUSD', 'oanda:NOPE'])
    expect(rows[2].error).toBe('no such instrument')
    const pool = poolBasket(rows)
    expect(pool.instruments).toBe(2)
    expect(pool.trades).toBe((rows[0].all?.trades ?? 0) + (rows[1].all?.trades ?? 0))
    expect(pool.r.n).toBe(rows[0].rs.all.length + rows[1].rs.all.length)
  })
})

describe('what an edit changed', () => {
  test("in the editor's words, each place once", () => {
    const a = strategy()
    const b = structuredClone(a)
    b.rules[0].maxStep = 6
    b.rules[2].steps = ['3m', '5m']
    if (b.exits.stop?.kind === 'atr') b.exits.stop.mult = 2
    b.costs.slippagePips = 0.3
    b.updatedAt += 1
    b.name = 'renamed'
    expect(strategyChanges(a, b)).toEqual(['Long · 4h · longest step', 'Long · 1h · steps', 'Exits · stop', 'Costs · slippage'])
    expect(describeChanges(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
    expect(describeChanges([])).toBe('no change')
  })
})

describe('the run history', () => {
  test('keeps each run with its changes; a repeat replaces; the baseline is pinned', async () => {
    const data = new FakeData()
    const history = new RunHistory()
    const s = strategy()
    const first = history.add(await runStrategy(s, data, { ...window, catalogue: null, now: NOW }), 1)
    expect(first.changes).toBeNull()
    // The same again: one record, not two.
    history.add(await runStrategy(s, data, { ...window, catalogue: null, now: NOW }), 2)
    expect(history.list(s.id)).toHaveLength(1)
    history.pin(s.id, history.list(s.id)[0].id)
    const edited = structuredClone(s)
    if (edited.exits.stop?.kind === 'atr') edited.exits.stop.mult = 2
    const second = history.add(await runStrategy(edited, data, { ...window, catalogue: null, now: NOW }), 3)
    expect(second.changes).toEqual(['Exits · stop'])
    expect(history.list(s.id)).toHaveLength(2)
    expect(history.baseline(s.id)?.ranAt).toBe(2)
    history.pin(s.id, null)
    expect(history.baseline(s.id)).toBeNull()
  })
})

describe('files', () => {
  test('a strategy round-trips through a file as a new strategy', () => {
    const s = strategy()
    s.costs.commission = 35
    s.holdout = { kind: 'percent', percent: 25 }
    const back = readStrategyFile(strategyJson(s), NOW + 1)
    expect(back.id).not.toBe(s.id)
    expect(back.createdAt).toBe(NOW + 1)
    expect({ ...back, id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt }).toEqual(s)
  })

  test('an older document reads with the new sections at their defaults', () => {
    const s = strategy() as Partial<Strategy>
    delete s.costs
    delete s.holdout
    const back = readStrategyFile(JSON.stringify(s), NOW)
    expect(back.costs).toEqual({ commission: 0, slippagePips: 0, financing: null })
    expect(back.holdout).toBeNull()
    expect(back.sizing.maxLeverage).toBe(50)
  })

  test('not a strategy', () => {
    expect(() => readStrategyFile('{nope', NOW)).toThrow(ImportError)
    expect(() => readStrategyFile('{"kind":"x"}', NOW)).toThrow(ImportError)
  })

  test('CSV: a row per entry and per trade, raw values, a header', async () => {
    const s = strategy()
    s.costs.slippagePips = 0.2
    const run = await runStrategy(s, new FakeData(), { ...window, catalogue: null, now: NOW })
    const entries = entriesCsv(run).trim().split('\n')
    expect(entries[0].split(',')).toContain('fwd_pips_48')
    expect(entries).toHaveLength(run.entries.length + run.filtered.length + 1)
    const trades = tradesCsv(run).trim().split('\n')
    expect(trades).toHaveLength((run.sim?.trades.length ?? 0) + 1)
    const header = trades[0].split(',')
    const first = trades[1].split(',')
    expect(first[header.indexOf('opened_utc')]).toMatch(/^\d{4}-\d\d-\d\dT/)
    expect(Number(first[header.indexOf('slippage')])).toBeGreaterThan(0)
  })
})
