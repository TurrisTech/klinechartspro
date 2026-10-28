import { afterAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// What one `calc` produces from the store the server's answer lands in: the markers on the bars
// that were open when each signal became knowable, the graph's dots, rings, stars and edges, and
// the "hide signals outside the graph" filter -- the path the pane actually renders, driven here
// end to end. What a graph IS is the server's (services/mtfgraph.py) and tested there.
installWindow()
const { calc, computeValues } = await import('./templates')
import type { ExtendData, Value } from './templates'
const { MTF_DEFAULTS } = await import('./config')
const { storeFor, dropStore } = await import('../plugins/store')
const { createMtfGraphStore, NODES_ARRAY } = await import('./store')
const { FX_SCHEDULE } = await import('../replay/timeframes')

import type { Indicator, KLineData } from 'klinecharts'
import type { MtfConfig } from './config'
import type { MtfInterval, MtfNodeRow, MtfSignalRow } from './api'

const M = 60_000
const H = 60 * M
// A synthetic instrument, so these stores cannot collide with another test file's: bun shares
// the module registry across files, and the store map is module state.
const KEY = 'mtf|test|oanda:ZZZGRAPH'
afterAll(() => dropStore(KEY))

const signal = (interval: string, date: number, knownAt: number, price: number, signal: 'long' | 'short', inGraph = false): MtfSignalRow => ({
  interval,
  date,
  knownAt,
  price,
  signal,
  side: signal === 'long' ? 'top' : 'bottom',
  p: signal === 'long' ? 0.7 : 0.3,
  inGraph
})

const node = (s: MtfSignalRow, root: string, parent: MtfSignalRow | null, entry = false): MtfNodeRow => ({
  interval: s.interval,
  date: s.date,
  knownAt: s.knownAt,
  price: s.price,
  root,
  graph: 0,
  side: s.side,
  entry,
  parent: parent && { interval: parent.interval, date: parent.date, knownAt: parent.knownAt, price: parent.price }
})

function seed(signals: MtfSignalRow[], nodes: MtfNodeRow[]): void {
  dropStore(KEY)
  storeFor(KEY, createMtfGraphStore).ingest(signals, { from: -1e13, to: 1e13 }, { [NODES_ARRAY]: nodes })
}

/** An hourly chart of `n` bars from 0. */
const chartBars = (n: number, step = H): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: i * step, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1 }) as KLineData)

function config(over: (c: MtfConfig) => void = () => {}): MtfConfig {
  const c = structuredClone(MTF_DEFAULTS)
  c.timeframes['1h'].enabled = true
  c.timeframes['4h'].enabled = true
  c.graph.roots = { '1D': false, '8h': false, '4h': true, '2h': false, '1h': false }
  over(c)
  return c
}

const extend = (c: MtfConfig, intervals: MtfInterval[] = ['1h', '4h'], graphRoots: MtfInterval[] = ['4h'], chartInterval = '1h'): ExtendData => ({
  seriesKeys: { graph: KEY },
  rev: 1,
  chartInterval,
  schedule: FX_SCHEDULE,
  config: c,
  graphRoots,
  intervals
})

// A 4h root top cast on bar 0 (known at 4h, body top 1.10); a 1h top above it, cast at 5h and
// known at 6h (in the graph); a 1h top below it, known at 8h (outside).
const ROOT = signal('4h', 0, 4 * H, 1.1, 'long', true)
const STEP = signal('1h', 5 * H, 6 * H, 1.12, 'long', true)
const OUTSIDE = signal('1h', 7 * H, 8 * H, 1.09, 'long')
const marksOf = (values: Value[]) => values.flatMap((v, i) => (v.marks ?? []).map((m) => `${m.interval}@bar${i}`))
const dotsOf = (values: Value[]) =>
  values.flatMap((v, i) => (v.dots ?? []).map((d) => `${d.interval}@bar${i}${d.root ? ' root' : ''}${d.entry ? ' entry' : ''}`))

describe('one calc, from the store to the markers', () => {
  test('every signal on the bar open when it became knowable, and the graph the server built', () => {
    seed([ROOT, STEP, OUTSIDE], [node(ROOT, '4h', null), node(STEP, '4h', ROOT)])
    const values = computeValues(chartBars(12), extend(config()))
    expect(marksOf(values)).toEqual(['4h@bar4', '1h@bar6', '1h@bar8'])
    expect(dotsOf(values)).toEqual(['4h@bar4 root', '1h@bar6'])
    expect(values[6].edges).toEqual([{ fromIndex: 4, fromPrice: 1.1, toPrice: 1.12, root: '4h', interval: '1h' }])
  })

  test('with "hide signals outside the graph" on, only the graph\'s own markers are left', () => {
    seed([ROOT, STEP, OUTSIDE], [node(ROOT, '4h', null), node(STEP, '4h', ROOT)])
    const values = computeValues(chartBars(12), extend(config((c) => (c.graph.onlyGraph = true))))
    expect(marksOf(values)).toEqual(['4h@bar4', '1h@bar6'])
    // ...and with no root drawn there is nothing to judge by: every marker stays.
    const rootless = computeValues(chartBars(12), extend(config((c) => (c.graph.onlyGraph = true)), ['1h', '4h'], []))
    expect(marksOf(rootless)).toEqual(['4h@bar4', '1h@bar6', '1h@bar8'])
    expect(dotsOf(rootless)).toEqual([])
  })

  test("a bar's marks stack shortest timeframe first, whatever order they were known in", () => {
    // Both known at 4h, so both on bar 4: the 1h one is the nearer to the candle.
    seed([ROOT, signal('1h', 3 * H, 4 * H, 1.105, 'long')], [])
    const values = computeValues(chartBars(12), extend(config(), ['1h', '4h'], []))
    expect(values[4].marks?.map((m) => `${m.interval}/${m.lane}`)).toEqual(['1h/0', '4h/1'])
  })

  test('a timeframe the pane does not draw is not drawn, and nothing past the loaded bars is', () => {
    seed([ROOT, signal('15m', 0, 15 * M, 1.11, 'long'), signal('1h', 20 * H, 21 * H, 1.2, 'long')], [])
    expect(marksOf(computeValues(chartBars(12), extend(config(), ['1h', '4h'], [])))).toEqual(['4h@bar4'])
  })

  test("what became knowable at the last bar's close is placed in the slot the next bar takes", () => {
    // A replay standing on 8h: bars 0..7 have closed and the bar opening at 8h has not printed.
    // The star a Next alert stopped at -- cast on bar 7, knowable at its close -- is drawn there
    // at once, with the edge into it, and stays there when that bar arrives.
    const star = signal('1h', 7 * H, 8 * H, 1.12, 'long', true)
    seed([ROOT, star], [node(ROOT, '4h', null), node(star, '4h', ROOT, true)])
    const values = computeValues(chartBars(8), extend(config()))
    expect(values).toHaveLength(9)
    expect(marksOf(values)).toEqual(['4h@bar4', '1h@bar8'])
    expect(dotsOf(values)).toEqual(['4h@bar4 root', '1h@bar8 entry'])
    expect(values[8].edges).toEqual([{ fromIndex: 4, fromPrice: 1.1, toPrice: 1.12, root: '4h', interval: '1h' }])
    const next = computeValues(chartBars(9), extend(config()))
    expect(next).toHaveLength(9)
    expect(dotsOf(next)).toEqual(dotsOf(values))
    // Nothing became knowable at the close: no slot.
    seed([ROOT], [node(ROOT, '4h', null)])
    expect(computeValues(chartBars(8), extend(config()))).toHaveLength(8)
  })

  test('a tick that only moves the forming bar reuses the last result; anything else recomputes', () => {
    seed([ROOT, STEP, OUTSIDE], [node(ROOT, '4h', null), node(STEP, '4h', ROOT)])
    const data = chartBars(12)
    // Only `extendData` is read, and the object's identity is what the reuse is keyed on.
    const indicator = { extendData: extend(config()) } as unknown as Indicator<Value, number, ExtendData>
    const first = calc(data, indicator)
    // The forming bar's prices change in place, as klinecharts applies a tick: same result.
    data[11] = { ...data[11], high: 1.2, close: 1.2 }
    expect(calc(data, indicator)).toBe(first)
    expect(first).toEqual(computeValues(data, extend(config())))
    // A new bar: klinecharts appends to the same array.
    data.push({ timestamp: 12 * H, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1 } as KLineData)
    const appended = calc(data, indicator)
    expect(appended).not.toBe(first)
    expect(appended.length).toBe(13)
    // A store update reaches the template as a new extendData with the host's new rev.
    indicator.extendData = { ...extend(config()), rev: 2 }
    const restored = calc(data, indicator)
    expect(restored).not.toBe(appended)
    // A reload or a page of history: klinecharts replaces the array.
    expect(calc([...data], indicator)).not.toBe(restored)
  })
})

describe('entries: a graph that reaches 5m draws a star there', () => {
  test('a 1h root -> 15m -> 5m -> 5m path: both 5m steps are stars, nothing above them is', () => {
    // 1h root top cast at 0 (known at 1h); a 15m top known at 105m; a 5m top known at 130m, and a
    // second known at 155m that supersedes it -- the server marks both entries.
    const root = signal('1h', 0, H, 1.1, 'long', true)
    const m15 = signal('15m', 90 * M, 105 * M, 1.11, 'long', true)
    const e1 = signal('5m', 125 * M, 130 * M, 1.12, 'long', true)
    const e2 = signal('5m', 150 * M, 155 * M, 1.13, 'long', true)
    seed([root, m15, e1, e2], [node(root, '1h', null), node(m15, '1h', root), node(e1, '1h', m15, true), node(e2, '1h', e1, true)])
    const c = structuredClone(MTF_DEFAULTS)
    for (const interval of ['1h', '15m', '5m'] as const) c.timeframes[interval].enabled = true
    c.graph.roots = { '1D': false, '8h': false, '4h': false, '2h': false, '1h': true }
    const values = computeValues(chartBars(48, 5 * M), extend(c, ['5m', '15m', '1h'], ['1h'], '5m'))
    expect(dotsOf(values)).toEqual(['1h@bar12 root', '15m@bar21', '5m@bar26 entry', '5m@bar31 entry'])
  })

  test('an edge from a parent older than the loaded bars comes in from the left', () => {
    const root = signal('1h', -3 * H, -2 * H, 1.1, 'long', true)
    const step = signal('5m', 5 * M, 10 * M, 1.12, 'long', true)
    seed([root, step], [node(root, '1h', null), node(step, '1h', root, true)])
    const c = structuredClone(MTF_DEFAULTS)
    c.timeframes['5m'].enabled = true
    const values = computeValues(chartBars(12, 5 * M), extend(c, ['5m', '1h'], ['1h'], '5m'))
    const edge = values[2].edges?.[0]
    // Two hours before the first bar, at the loaded bars' own spacing: 24 bars to the left.
    expect(edge?.fromIndex).toBe(-24)
    expect(dotsOf(values)).toEqual(['5m@bar2 entry'])
  })
})
