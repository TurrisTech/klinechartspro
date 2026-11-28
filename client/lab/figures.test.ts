import { beforeAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// THE SUMMARY'S COUNTS (figures.ts), without a DOM: forward pips horizon by horizon and how sure
// each mean is, the trades month by month on the instrument's clock, the entries the account did
// not take and why, and the signals inside the window. The one-row figures and their columns are
// research.test.ts's.
installWindow()
const { byMonth, figuresOf, forwardStats, notTaken, signalsInWindow } = await import('./figures')
const { meanStats } = await import('./stats')
const { runStrategy } = await import('./runner')
const { rank85Strategy } = await import('./model')
const { FakeData, NOW, D, withRules } = await import('./testdata')

import type { LabRun } from './runner'
import type { LabTrade, SimResult } from './trades'

let run: LabRun

beforeAll(async () => {
  const s = rank85Strategy(NOW)
  withRules(s, ['4h', '1h'], ['3m', '5m', '15m', '1h', '4h'])
  run = await runStrategy(s, new FakeData(), { from: NOW - 10 * D, to: NOW, catalogue: null, now: NOW })
})

/** A run holding only closed trades, on New York's clock: what `byMonth` reads. */
function tradesRun(trades: Array<Partial<LabTrade>>): LabRun {
  return { grid: { schedule: { timezone: 'America/New_York' } }, sim: { trades } } as unknown as LabRun
}

describe('forward pips, horizon by horizon', () => {
  test('one interval per horizon of the side, over that side’s entries', () => {
    expect(run.entries.length).toBeGreaterThan(3)
    for (const side of ['all', 'long', 'short'] as const) {
      const stats = forwardStats(run, side)
      const summary = run.summary[side]
      expect(stats).toHaveLength(summary.horizons.length)
      // Each mean is the outcome summary's own, over the same entries.
      stats.forEach((st, h) => {
        expect(st.n).toBe(summary.horizons[h].n)
        if (st.mean !== null && summary.horizons[h].meanPips !== null) expect(st.mean).toBeCloseTo(summary.horizons[h].meanPips as number, 9)
      })
    }
  })

  test('the longest horizon over all entries is the figures’ forward pips', () => {
    const stats = forwardStats(run, 'all')
    expect(stats.at(-1)).toEqual(figuresOf(run).forward)
  })

  test('a side counts only its own entries', () => {
    const longs = run.entries.filter((e) => e.direction === 'long')
    const pips = longs.flatMap((e) => {
      const p = run.outcomes.get(e.id)?.forward[0]?.pips
      return p === undefined || !Number.isFinite(p) ? [] : [p]
    })
    expect(forwardStats(run, 'long')[0]).toEqual(meanStats(pips))
  })
})

describe('the trades month by month', () => {
  test('by the month each closed in, on the instrument’s clock, oldest first', () => {
    const months = byMonth(
      tradesRun([
        { closedAt: Date.UTC(2026, 2, 3, 12), pnl: 120, r: 1.2, pips: 12 },
        // 04:30 UTC on 1 February is 23:30 on 31 January in New York: January's.
        { closedAt: Date.UTC(2026, 0, 31, 22), pnl: -50, r: -0.5, pips: -5 },
        { closedAt: Date.UTC(2026, 1, 1, 4, 30), pnl: 30, r: null, pips: null },
        { closedAt: Date.UTC(2026, 2, 20, 12), pnl: 0, r: 0, pips: 0 }
      ])
    )
    expect(months).toEqual([
      { month: 'Jan 2026', trades: 2, wins: 1, r: -0.5, pips: -5, pnl: -20 },
      { month: 'Mar 2026', trades: 2, wins: 1, r: 1.2, pips: 12, pnl: 120 }
    ])
  })

  test('a trade still open, or with no P&L, is left out', () => {
    expect(byMonth(tradesRun([{ closedAt: null, pnl: null }, { closedAt: Date.UTC(2026, 2, 3), pnl: null }]))).toEqual([])
    expect(byMonth({ grid: { schedule: { timezone: 'UTC' } }, sim: null } as unknown as LabRun)).toEqual([])
  })

  test('over a real run, every closed trade once', () => {
    const closed = (run.sim?.trades ?? []).filter((t) => t.closedAt !== null && t.pnl !== null)
    const months = byMonth(run)
    expect(months.reduce((n, m) => n + m.trades, 0)).toBe(closed.length)
    expect(months.reduce((n, m) => n + m.pnl, 0)).toBeCloseTo(closed.reduce((n, t) => n + (t.pnl as number), 0), 6)
  })
})

describe('the rest of the Summary’s counts', () => {
  test('entries not taken, by why, in the order each reason first came', () => {
    const sim = { skipped: [{ reason: 'b' }, { reason: 'a' }, { reason: 'b' }, { reason: 'b' }] } as unknown as SimResult
    expect(notTaken(sim)).toEqual([
      ['b', 3],
      ['a', 1]
    ])
    expect(notTaken({ skipped: [] } as unknown as SimResult)).toEqual([])
  })

  test('the signals inside the window, its two ends included, not the lead-in before it', () => {
    const before = run.signals.filter((s) => s.knownAt < run.from).length
    expect(before).toBeGreaterThan(0)
    expect(signalsInWindow(run)).toBe(run.signals.filter((s) => s.knownAt >= run.from && s.knownAt <= run.to).length)
    const edges = { ...run, signals: [{ knownAt: run.from }, { knownAt: run.to }, { knownAt: run.from - 1 }, { knownAt: run.to + 1 }] } as unknown as LabRun
    expect(signalsInWindow(edges)).toBe(2)
  })
})
