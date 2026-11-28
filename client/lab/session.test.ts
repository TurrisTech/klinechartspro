import { afterEach, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// THE LAB'S SESSION (session.ts), without a DOM, on the fake data at a fixed instant: which
// strategy a visit opens on; editing the draft in place and what that makes unsaved; a run, a
// run overtaken by a newer one, Stop, and a draft that cannot run; Save, Revert, Delete, New and
// a file read back; and this session's runs with their baseline. What page.ts draws of it is
// not tested here.
installWindow()
const { LabSession } = await import('./session')
const { StrategyStore } = await import('./store')
const { rank85Strategy } = await import('./model')
const { ImportError, strategyJson } = await import('./export')
const { FakeData, NOW, D, withRules } = await import('./testdata')

import type { Strategy } from './model'
import type { LabOpening, LabSessionDeps } from './session'

const stores: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose()
})

/** A strategy the fake data runs quickly: two roots over the ten days to NOW. As dates, since a
 * run reads the time itself (runner.ts), not the session's clock. */
function strategy(name: string, now = NOW): Strategy {
  const s = rank85Strategy(now)
  s.name = name
  s.window = { kind: 'range', from: NOW - 10 * D, to: NOW }
  withRules(s, ['4h', '1h'], ['3m', '5m', '15m', '1h', '4h'])
  return s
}

/** A session over a store holding `saved`, and what its persistence was asked to write. */
async function setup(saved: Strategy[] = [], opening: LabOpening = { requested: null, remembered: null }) {
  const writes: string[] = []
  const store = new StrategyStore({ load: async () => ({}), save: (key) => writes.push(`save ${key}`), remove: (key) => writes.push(`remove ${key}`) })
  stores.push(store)
  await store.load()
  for (const s of saved) store.save(s, NOW - D)
  writes.length = 0
  const data = new FakeData()
  const others: Array<InstanceType<typeof FakeData>> = []
  const deps: LabSessionDeps = {
    store,
    data,
    newData: () => {
      const d = new FakeData()
      others.push(d)
      return d
    },
    catalogue: null,
    clock: () => NOW
  }
  return { session: new LabSession(deps, opening), store, data, others, writes }
}

describe('where a visit opens', () => {
  test('with nothing saved, on a fresh rank 85 draft that holds nothing of the user’s', async () => {
    const { session } = await setup()
    expect(session.current.name).toBe('AREV21 rank 85 rules')
    expect(session.current.createdAt).toBe(NOW)
    expect(session.isSaved()).toBe(false)
    expect(session.unsaved(session.currentId)).toBe(true)
    // Unsaved, but nothing to discard and nothing to ask about before the page closes.
    expect(session.removable).toBe(false)
    expect(session.hasUnsavedWork()).toBe(false)
    expect(session.strategies()).toEqual([{ id: session.currentId, name: 'AREV21 rank 85 rules', saved: false, unsaved: true }])
  })

  test('on the strategy the address names, else the one open last, else the first saved', async () => {
    const a = strategy('A')
    const b = strategy('B')
    const c = strategy('C')
    expect((await setup([a, b, c], { requested: b.id, remembered: c.id })).session.currentId).toBe(b.id)
    expect((await setup([a, b, c], { requested: 'gone', remembered: c.id })).session.currentId).toBe(c.id)
    expect((await setup([a, b, c], { requested: null, remembered: 'gone' })).session.currentId).toBe(a.id)
    const { session } = await setup([a, b])
    // Every saved strategy is a draft of the visit, saved and unchanged.
    expect(session.strategies().map((s) => [s.name, s.saved, s.unsaved])).toEqual([
      ['A', true, false],
      ['B', true, false]
    ])
    expect(session.current).not.toBe(a)
    expect(session.current).toEqual({ ...a, updatedAt: NOW - D })
  })

  test('another strategy opens on its draft, which keeps its edits; an unknown one changes nothing', async () => {
    const a = strategy('A')
    const b = strategy('B')
    const { session } = await setup([a, b])
    session.rename('A, edited')
    expect(session.open(b.id)).toBe(true)
    expect(session.current.name).toBe('B')
    expect(session.open('gone')).toBe(false)
    expect(session.currentId).toBe(b.id)
    session.open(a.id)
    expect(session.current.name).toBe('A, edited')
    expect(session.unsaved(a.id)).toBe(true)
  })
})

describe('editing the draft', () => {
  test('in place: the editor holds the draft, and every header setting keeps it the same object', async () => {
    const { session } = await setup([strategy('A')])
    const draft = session.current
    session.rename('A2')
    session.setInstrument('oanda:GBPUSD')
    session.setWindowKind('range')
    session.setHoldoutKind('percent')
    expect(session.setDays(7)).toBe(true)
    expect(session.current).toBe(draft)
    expect([draft.name, draft.instrument, draft.window, draft.holdout]).toEqual(['A2', 'oanda:GBPUSD', { kind: 'days', days: 7 }, { kind: 'percent', percent: 30 }])
  })

  test('the window: N days rounded, dates as UTC days with the last included, the kind by the clock', async () => {
    const { session } = await setup([strategy('A')])
    expect(session.setDays(7.4)).toBe(true)
    expect(session.current.window).toEqual({ kind: 'days', days: 7 })
    expect(session.setDays(0.4)).toBe(false)
    expect(session.current.window).toEqual({ kind: 'days', days: 7 })
    // Seven days as dates, from the clock's day: the 7th through the 13th of March.
    session.setWindowKind('range')
    expect(session.current.window).toEqual({ kind: 'range', from: Date.UTC(2026, 2, 7), to: Date.UTC(2026, 2, 14) })
    expect(session.setRange('2026-03-01', '2026-03-10')).toBe(true)
    expect(session.current.window).toEqual({ kind: 'range', from: Date.UTC(2026, 2, 1), to: Date.UTC(2026, 2, 11) })
    expect(session.setRange('2026-03-01', '')).toBe(false)
    session.setWindowKind('days')
    expect(session.current.window).toEqual({ kind: 'days', days: 10 })
  })

  test('the holdout: a percent strictly inside 0..100, a day that reads, from 30% back of the window', async () => {
    const { session } = await setup([strategy('A')])
    // Ten days back from the clock: 30% of them is three days before it.
    session.setHoldoutKind('from')
    expect(session.current.holdout).toEqual({ kind: 'from', at: Date.UTC(2026, 2, 10) })
    expect(session.setHoldoutPercent(100)).toBe(false)
    expect(session.setHoldoutPercent(25)).toBe(true)
    expect(session.current.holdout).toEqual({ kind: 'percent', percent: 25 })
    expect(session.setHoldoutFrom('')).toBe(false)
    expect(session.setHoldoutFrom('2026-03-05')).toBe(true)
    expect(session.current.holdout).toEqual({ kind: 'from', at: Date.UTC(2026, 2, 5) })
    session.setHoldoutKind('')
    expect(session.current.holdout).toBeNull()
  })

  test('an edit makes the draft unsaved; once touched, the page asks before it closes', async () => {
    const a = strategy('A')
    const { session } = await setup([a])
    session.current.exits.maxBars = null
    expect(session.unsaved(a.id)).toBe(true)
    expect(session.strategies()[0]).toEqual({ id: a.id, name: 'A', saved: true, unsaved: true })
    expect(session.hasUnsavedWork()).toBe(false)
    session.touch()
    expect(session.hasUnsavedWork()).toBe(true)
    // When the save time alone differs, nothing is unsaved.
    session.current.exits.maxBars = a.exits.maxBars
    expect(session.unsaved(a.id)).toBe(false)
  })
})

describe('running', () => {
  test('a run of the draft is kept as the last run and in the history; settled, nothing runs', async () => {
    const { session } = await setup([strategy('A')])
    expect(session.running).toBe(false)
    const stages: string[] = []
    const pending = session.run((text) => stages.push(text))
    expect(session.running).toBe(true)
    const outcome = await pending
    if (outcome.kind !== 'done') throw new Error(`the run did not finish: ${outcome.kind}`)
    expect(outcome.run.entries.length).toBeGreaterThan(0)
    expect(stages[0]).toBe('Reading the instrument')
    expect(session.lastRun).toBe(outcome.run)
    expect(session.runs()).toHaveLength(1)
    expect(session.runs()[0].ranAt).toBe(NOW)
    expect(session.shownRunId()).toBe(session.runs()[0].id)
    expect(session.signalCounts()?.size).toBeGreaterThan(0)
    // Until its outcome is settled, the run is still going (the page is drawing it).
    expect(session.running).toBe(true)
    expect(session.settle(outcome.ticket)).toBe(true)
    expect(session.running).toBe(false)
    expect(session.isLatest(outcome.ticket)).toBe(false)
  })

  test('a run is of a copy: editing on while it runs changes nothing in it', async () => {
    const { session } = await setup([strategy('A')])
    const pending = session.run(() => {})
    session.rename('renamed while running')
    const outcome = await pending
    expect(outcome.kind === 'done' && outcome.run.strategy.name).toBe('A')
  })

  test('a newer run abandons the one before: no word from it after, and nothing of it kept', async () => {
    const { session } = await setup([strategy('A')])
    const heard: string[] = []
    const first = session.run((text) => heard.push(`first: ${text}`))
    const second = session.run((text) => heard.push(`second: ${text}`))
    const [a, b] = await Promise.all([first, second])
    expect(a.kind).toBe('cancelled')
    expect(b.kind).toBe('done')
    const firstOfSecond = heard.findIndex((h) => h.startsWith('second'))
    expect(heard.slice(firstOfSecond).every((h) => h.startsWith('second'))).toBe(true)
    // The first's settling does not end the second.
    expect(session.settle(a.ticket)).toBe(false)
    expect(session.running).toBe(true)
    expect(session.runs()).toHaveLength(1)
    expect(session.lastRun).toBe(b.kind === 'done' ? b.run : null)
  })

  test('Stop abandons the run; the last finished one stays', async () => {
    const { session } = await setup([strategy('A')])
    const done = await session.run(() => {})
    session.settle(done.ticket)
    const pending = session.run(() => {})
    session.stop()
    expect(session.running).toBe(false)
    expect((await pending).kind).toBe('cancelled')
    expect(session.lastRun).toBe(done.kind === 'done' ? done.run : null)
    expect(session.runs()).toHaveLength(1)
  })

  test('opening another strategy abandons the run, and no run is shown for it', async () => {
    const a = strategy('A')
    const b = strategy('B')
    const { session } = await setup([a, b])
    await session.run(() => {})
    expect(session.signalCounts()).not.toBeNull()
    const pending = session.run(() => {})
    session.open(b.id)
    expect((await pending).kind).toBe('cancelled')
    expect(session.lastRun).toBeNull()
    expect(session.signalCounts()).toBeNull()
    expect(session.shownRunId()).toBeNull()
    expect(session.runs()).toEqual([])
    // Its runs are kept with it.
    session.open(a.id)
    expect(session.runs()).toHaveLength(1)
  })

  test('a draft that cannot run says why, and keeps the last run', async () => {
    const { session } = await setup([strategy('A')])
    for (const rule of session.current.rules) rule.enabled = false
    expect(session.problems().map((p) => p.where)).toEqual(['Rules'])
    const outcome = await session.run(() => {})
    expect(outcome.kind).toBe('problems')
    if (outcome.kind === 'problems') {
      expect(outcome.problems).toEqual(session.problems())
      expect(outcome.message).toBe('1 problem to fix first')
    }
    expect(session.lastRun).toBeNull()
  })

  test('a sweep reads through the page’s data; a basket too on its own instrument, else data of its own', async () => {
    const { session, data, others } = await setup([strategy('A')])
    const sweep = await session.sweepRun(structuredClone(session.current), () => false)
    expect(sweep.rules.every((r) => r.sim === null)).toBe(true)
    const reads = data.reads.length
    await session.basketRun(structuredClone(session.current), 'oanda:EURUSD', () => false)
    expect(others).toHaveLength(0)
    await session.basketRun(structuredClone(session.current), 'oanda:GBPUSD', () => false)
    expect(others).toHaveLength(1)
    expect(others[0].reads.length).toBeGreaterThan(0)
    expect(data.reads.length).toBeGreaterThanOrEqual(reads)
  })
})

describe('saving, reverting, deleting, new', () => {
  test('Save keeps the draft; it is saved and unchanged until the next edit', async () => {
    const { session, store, writes } = await setup()
    const id = session.currentId
    session.rename('Mine')
    session.touch()
    session.save()
    expect(writes).toEqual([`save strategy.${id}`, 'save strategies'])
    expect(store.get(id)?.name).toBe('Mine')
    expect(store.get(id)?.updatedAt).toBe(NOW)
    expect(session.isSaved()).toBe(true)
    expect(session.unsaved(id)).toBe(false)
    expect(session.hasUnsavedWork()).toBe(false)
    expect(session.removable).toBe(true)
    session.rename('Mine, again')
    expect(session.unsaved(id)).toBe(true)
    expect(store.get(id)?.name).toBe('Mine')
  })

  test('after Save the editor still holds the draft: its next edit is unsaved work, and what a run reads', async () => {
    // The editor keeps the object it was given. Until 2026-11-28 Save put a fresh copy in its
    // place, so every edit after a visit's first Save went to an object nothing read: Save stayed
    // disabled and runs ignored it.
    const { session } = await setup()
    const held = session.current
    session.rename('Mine')
    session.touch()
    session.save()
    expect(session.current).toBe(held)
    held.rules[0].enabled = !held.rules[0].enabled
    session.touch()
    expect(session.unsaved(session.currentId)).toBe(true)
    expect(session.current.rules[0].enabled).toBe(held.rules[0].enabled)
  })

  test('a store that cannot save throws, and the draft stays unsaved', async () => {
    const { session, store } = await setup()
    store.loadError = 'cannot read'
    expect(() => session.save()).toThrow('cannot read')
    expect(session.isSaved()).toBe(false)
  })

  test('Revert puts the saved version back; a draft never saved has none', async () => {
    const a = strategy('A')
    const { session } = await setup([a])
    session.rename('changed')
    expect(session.revert()).toBe(true)
    expect(session.current.name).toBe('A')
    expect(session.unsaved(a.id)).toBe(false)
    session.create('rank85')
    expect(session.revert()).toBe(false)
  })

  test('Delete removes a saved strategy and opens the next draft; the last one leaves a fresh default', async () => {
    const a = strategy('A')
    const b = strategy('B')
    const { session, store, writes } = await setup([a, b])
    expect(session.remove()).toBe(b.id)
    expect(session.currentId).toBe(b.id)
    expect(store.get(a.id)).toBeNull()
    expect(writes).toEqual([`remove strategy.${a.id}`, 'save strategies'])
    const fresh = session.remove()
    expect(session.currentId).toBe(fresh)
    expect(session.current.name).toBe('AREV21 rank 85 rules')
    expect(session.removable).toBe(false)
    expect(session.strategies().map((s) => s.id)).toEqual([fresh])
  })

  test('a draft never saved is discarded without a write; a store that cannot delete changes nothing', async () => {
    const a = strategy('A')
    const { session, store, writes } = await setup([a])
    const made = session.create('rule')
    expect(session.remove()).toBe(a.id)
    expect(writes).toEqual([])
    expect(session.strategies().map((s) => s.id)).not.toContain(made)
    store.loadError = 'cannot read'
    expect(() => session.remove()).toThrow('cannot read')
    expect(session.currentId).toBe(a.id)
    expect(session.strategies().map((s) => s.id)).toEqual([a.id])
  })

  test('New: a draft on the open instrument, touched and opened; a copy is this one under a new id', async () => {
    const a = strategy('A')
    a.instrument = 'oanda:GBPUSD'
    const { session } = await setup([a])
    const rule = session.create('rule')
    expect(session.currentId).toBe(rule)
    expect([session.current.name, session.current.instrument, session.isSaved(), session.removable]).toEqual(['RSI(14) crosses', 'oanda:GBPUSD', false, true])
    expect(session.hasUnsavedWork()).toBe(true)
    session.open(a.id)
    const copy = session.create('copy')
    expect(copy).not.toBe(a.id)
    expect([session.current.name, session.current.createdAt, session.current.rules]).toEqual(['A copy', NOW, a.rules])
    expect(session.strategies().map((s) => [s.name, s.saved])).toEqual([
      ['A', true],
      ['RSI(14) crosses', false],
      ['A copy', false]
    ])
  })

  test('a file read back is a new draft, opened; one that is not a strategy changes nothing', async () => {
    const a = strategy('A')
    const { session } = await setup([a])
    const id = session.importFile(strategyJson(a))
    expect(id).not.toBe(a.id)
    expect(session.currentId).toBe(id)
    expect([session.current.name, session.current.createdAt, session.isSaved()]).toEqual(['A', NOW, false])
    expect(() => session.importFile('{not json')).toThrow(ImportError)
    expect(session.currentId).toBe(id)
  })
})

describe('this session’s runs', () => {
  test('a run restored is the draft again, under the open strategy’s id', async () => {
    const a = strategy('A')
    const { session } = await setup([a])
    await session.run(() => {})
    const [record] = session.runs()
    session.current.exits.maxBars = null
    session.restore(record)
    const restored = session.current
    expect(restored.id).toBe(a.id)
    expect(restored.exits.maxBars).toEqual(a.exits.maxBars)
    expect(restored).not.toBe(record.strategy)
  })

  test('the baseline is set beside the run shown, but not when it IS the run shown', async () => {
    const { session } = await setup([strategy('A')])
    await session.run(() => {})
    session.current.exits.maxBars = { count: 12, interval: null }
    await session.run(() => {})
    const [first, second] = session.runs()
    expect([session.runNumber(first), session.runNumber(second)]).toEqual([1, 2])
    expect(session.shownRunId()).toBe(second.id)
    expect(session.comparedBaseline()).toBeNull()
    session.pin(first)
    expect(session.baseline()).toBe(first)
    expect(session.comparedBaseline()).toBe(first)
    session.pin(second)
    expect(session.comparedBaseline()).toBeNull()
    session.pin(null)
    expect(session.baseline()).toBeNull()
  })
})
