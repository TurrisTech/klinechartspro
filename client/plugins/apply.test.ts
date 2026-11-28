import { afterEach, describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

installWindow()
const { aggregateRev, applyBinding, createApplyCoalescer, problemOf } = await import('./apply')
const { WindowStore } = await import('./store')
const { fakeChart, fakeIndicator, flush } = await import('./testing')
import type { AppliedBinding } from './apply'
import type { BoundSource, SourceStore } from './types'

// What one re-apply hands the chart, and that re-applies asked for together run once.

function source(id: string, store: SourceStore = new WindowStore(id)): BoundSource {
  return { id, key: `k|${id}`, store }
}

function binding(over: Partial<AppliedBinding> = {}): AppliedBinding & { fc: ReturnType<typeof fakeChart> } {
  const fc = fakeChart()
  fc.indicators = [fakeIndicator('X', 'i1')]
  const sources = over.sources ?? [source('a')]
  return {
    fc,
    plugin: { id: 'x' },
    chart: fc.chart,
    indicatorId: 'i1',
    name: 'X',
    chartPaneId: 'candle_pane',
    seq: 1,
    spec: { label: () => 'X' },
    sources,
    state: { sources: [...sources], chartInterval: '1h' },
    disposed: false,
    lastAppliedRev: -1,
    lastShortName: '',
    ...over
  }
}

describe('aggregateRev', () => {
  test("the binding's sequence, then every store's revision", () => {
    const a = new WindowStore('a')
    const b = new WindowStore('b')
    a.rev = 3
    b.rev = 4
    expect(aggregateRev({ seq: 2, sources: [source('a', a), source('b', b)] })).toBe(2 * 1_000_003 + 7)
    // A rebind keeping both stores still moves it.
    expect(aggregateRev({ seq: 3, sources: [source('a', a), source('b', b)] })).not.toBe(aggregateRev({ seq: 2, sources: [source('a', a), source('b', b)] }))
  })
})

describe('problemOf', () => {
  test('a source that failed beats one that loaded only partly, and nothing wrong is null', () => {
    const partial = new WindowStore('p')
    partial.setProblem('4h could not be read')
    const failed = new WindowStore('f')
    failed.setPhase('error', null, 'boom')
    expect(problemOf({ sources: [source('ok')] })).toBeNull()
    expect(problemOf({ sources: [source('p', partial)] })).toBe('4h could not be read')
    expect(problemOf({ sources: [source('p', partial), source('f', failed)] })).toBe('Could not be loaded: boom')
    failed.setPhase('error')
    expect(problemOf({ sources: [source('f', failed)] })).toBe('Could not be loaded: unknown error')
  })
})

describe('applyBinding', () => {
  test("sends the keys, the rev, the plugin's own data and the host's problem -- and nothing again until one moves", () => {
    const b = binding({ spec: { label: () => 'X 1h', extendData: () => ({ mine: 1, problem: 'hidden' }) } })
    applyBinding(b)
    expect(b.fc.overrides).toEqual([
      {
        id: 'i1',
        name: 'X',
        paneId: 'candle_pane',
        shortName: 'X 1h',
        extendData: { seriesKey: 'k|a', seriesKeys: { a: 'k|a' }, rev: 1_000_003, mine: 1, problem: null }
      }
    ])
    applyBinding(b)
    expect(b.fc.overrides).toHaveLength(1)
    b.sources[0].store.rev++
    applyBinding(b)
    expect(b.fc.overrides).toHaveLength(2)
  })

  test('a label that throws reads as the template name; a released binding is not applied', () => {
    const b = binding({
      spec: {
        label: () => {
          throw new Error('no')
        }
      }
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      applyBinding(b)
    } finally {
      console.warn = warn
    }
    expect(b.fc.overrides[0].shortName).toBe('X')
    const gone = binding({ disposed: true })
    applyBinding(gone)
    expect(gone.fc.overrides).toEqual([])
  })
})

describe('createApplyCoalescer', () => {
  const realRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame
  afterEach(() => {
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = realRaf
  })

  test('without animation frames, every key asked for in one task runs once, at its end', async () => {
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined
    const ran: string[] = []
    const applies = createApplyCoalescer<string>((key) => ran.push(key))
    applies.request('a')
    applies.request('b')
    applies.request('a')
    expect(applies.pending).toBe(2)
    expect(ran).toEqual([])
    await flush()
    expect(ran).toEqual(['a', 'b'])
    expect(applies.pending).toBe(0)
  })

  test('on the next frame, once, whether the frame or the fallback timer comes first', async () => {
    const frames: Array<() => void> = []
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => frames.push(fn)
    const ran: string[] = []
    const applies = createApplyCoalescer<string>((key) => ran.push(key))
    applies.request('a')
    applies.request('b')
    expect(frames).toHaveLength(1)
    frames[0]()
    expect(ran).toEqual(['a', 'b'])
    // The fallback timer for that frame finds nothing to do.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(ran).toEqual(['a', 'b'])
    // No frame comes (a hidden tab): the timer runs it.
    applies.request('c')
    expect(frames).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(ran).toEqual(['a', 'b', 'c'])
    frames[1]()
    expect(ran).toEqual(['a', 'b', 'c'])
  })

  test('flush runs what is waiting at once, and the frame then has nothing left', () => {
    const frames: Array<() => void> = []
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (fn: () => void) => frames.push(fn)
    const ran: string[] = []
    const applies = createApplyCoalescer<string>((key) => ran.push(key))
    applies.request('a')
    applies.flush()
    expect(ran).toEqual(['a'])
    frames[0]()
    expect(ran).toEqual(['a'])
  })
})
