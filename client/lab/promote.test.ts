import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// Where a developed strategy goes: the saved set, a dashboard pane's run, and an alert operand.
installWindow()
const { StrategyStore, localPersistence } = await import('./store')
const { rank85Strategy } = await import('./model')
const { RunStore } = await import('./plugin')
const { StrategyEntryEngine, lastClosedOpen, LATE_MS } = await import('./alertentries')
const { compile, operandKey, describeRule } = await import('../alerts/rules')
const { FX_GRID } = await import('../replay/timeframes')

import type { StrategyPersistence } from './store'

function memory(initial: Record<string, unknown> = {}): StrategyPersistence & { data: Record<string, unknown>; fail: boolean } {
  const data = { ...initial }
  const p = {
    data,
    fail: false,
    load: async () => {
      if (p.fail) throw new Error('unreadable')
      return structuredClone(data)
    },
    save: (key: string, value: unknown) => {
      data[key] = structuredClone(value)
    },
    remove: (key: string) => {
      delete data[key]
    }
  }
  return p
}

/** A Storage over a list of entries, listed in the order given. */
function storageOf(entries: Array<[string, string]>): Storage {
  const map = new Map(entries)
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear()
  }
}

describe('the saved strategies', () => {
  test('in this browser: the page’s own settings beside them hide nothing', async () => {
    // The page keeps plain strings under the same prefix; listed first, they once stopped the read.
    const a = rank85Strategy(1)
    const storage = storageOf([
      ['wd.lab.current', a.id],
      ['wd.lab.tab', 'summary'],
      ['wd.lab.strategy.broken', '{not json'],
      ['wd.lab.strategies', JSON.stringify({ version: 1, order: [a.id] })],
      [`wd.lab.strategy.${a.id}`, JSON.stringify(a)]
    ])
    const store = new StrategyStore(localPersistence(() => storage))
    await store.load()
    expect(store.list().map((x) => x.id)).toEqual([a.id])
    store.dispose()
  })

  test('one key per strategy plus an index; a save reads back', async () => {
    const persistence = memory()
    const store = new StrategyStore(persistence)
    await store.load()
    const a = rank85Strategy(1)
    const saved = store.save(a, 5)
    expect(saved.updatedAt).toBe(5)
    expect(Object.keys(persistence.data).sort()).toEqual(['strategies', `strategy.${a.id}`])
    const again = new StrategyStore(persistence)
    await again.load()
    expect(again.list().map((s) => s.id)).toEqual([a.id])
    expect(again.get(a.id)?.rules).toEqual(a.rules)
    again.remove(a.id)
    expect(Object.keys(persistence.data)).toEqual(['strategies'])
    store.dispose()
    again.dispose()
  })

  test('an unreadable store refuses every write, so the stored set is never overwritten', async () => {
    const persistence = memory()
    persistence.fail = true
    const store = new StrategyStore(persistence)
    await store.load()
    expect(store.loadError).not.toBe('')
    expect(() => store.save(rank85Strategy(1))).toThrow()
    expect(persistence.data).toEqual({})
    store.dispose()
  })

  test('a strategy that no longer reads is dropped, the rest kept', async () => {
    const good = rank85Strategy(1)
    const persistence = memory({ strategies: { version: 1, order: ['bad', good.id] }, 'strategy.bad': { version: 99 }, [`strategy.${good.id}`]: good })
    const store = new StrategyStore(persistence)
    await store.load()
    expect(store.list().map((s) => s.id)).toEqual([good.id])
    store.dispose()
  })
})

describe('a pane’s run store', () => {
  test('a run covers one span: anything outside it asks for the whole union', () => {
    const store = new RunStore('k')
    expect(store.missing({ from: 10, to: 20 })).toEqual([{ from: 10, to: 20 }])
    store.ingest([], { from: 10, to: 20 })
    expect(store.missing({ from: 12, to: 18 })).toEqual([])
    expect(store.missing({ from: 5, to: 18 })).toEqual([{ from: 5, to: 20 }])
    store.stale = true
    expect(store.missing({ from: 12, to: 18 })).toEqual([{ from: 10, to: 20 }])
  })
})

describe('a strategy’s entries as an alert operand', () => {
  test('the operand compiles, keys and reads as a label', () => {
    const rule = { left: { kind: 'strategy' as const, interval: '5m', strategy: 'st1' }, op: '==', right: { label: 'long' } }
    const compiled = compile(rule)
    expect(compiled.condition).toEqual({ field: 'strat:st1@5m', op: '==', value: 'long' })
    expect(operandKey(rule.left)).toBe('strat:st1@5m')
    expect(describeRule(rule)).toBe('st1 entry 5m is long')
    expect(() => compile({ ...rule, left: { ...rule.left, strategy: '' } })).toThrow('choose a saved strategy')
  })

  test('final through the last bar closed LATE_MS before the end', () => {
    // A Tuesday, 10:07:30 New York: the 10:00 5m bar closed at 10:05.
    const at = Date.UTC(2026, 0, 6, 15, 7, 30)
    expect(lastClosedOpen(FX_GRID, '5m', at)).toBe(Date.UTC(2026, 0, 6, 15, 0))
    expect(lastClosedOpen(FX_GRID, '5m', Date.UTC(2026, 0, 6, 15, 5))).toBe(Date.UTC(2026, 0, 6, 15, 0))
    expect(LATE_MS).toBeGreaterThan(0)
  })

  test('an unknown strategy has no entries and nothing final', async () => {
    const persistence = memory()
    const store = new StrategyStore(persistence)
    await store.load()
    const engine = new StrategyEntryEngine(
      { grid: async () => FX_GRID, pip: async () => 0.0001, bars: async () => [], signals: async () => [], points: async () => [] },
      async () => store
    )
    expect(await engine.entries('oanda:EURUSD', { kind: 'strategy', interval: '5m', strategy: 'gone' }, 0, 1)).toEqual({ points: [], through: null })
    store.dispose()
  })
})
