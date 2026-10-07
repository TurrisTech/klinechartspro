import { afterAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// What one `calc` produces from real stores: the markers, the graphs over them, and the
// "hide signals outside the graph" filter -- the path the pane actually renders, driven here
// end to end rather than through its pieces.
installWindow()
const { calc, computeValues } = await import('./templates')
import type { ExtendData, Value } from './templates'
const { MTF_DEFAULTS } = await import('./config')
const { GRID_ARRAY, RegistryStore } = await import('../tsregistry/store')
const { storeFor } = await import('../plugins/store')
const { FX_SCHEDULE } = await import('../replay/timeframes')

import type { ArevPoint } from '../arev/api'
import type { Indicator, KLineData } from 'klinecharts'
import type { MtfConfig } from './config'

const H = 3_600_000
// A synthetic instrument, so these stores cannot collide with another test file's: bun shares
// the module registry across files, and the store map is module state.
const SYM = 'oanda:ZZZGRAPH'

const point = (date: number, signal: 'long' | 'short'): ArevPoint =>
  ({ date, prediction: 0, n: 200, p: signal === 'long' ? 0.7 : 0.3, confidence: 0.2, atCross: true, signal }) as ArevPoint

/** A store of one timeframe's signals, on a grid of `bars` bodies rising then falling. */
function store(key: string, bars: Array<{ date: number; open: number; close: number }>, signals: Array<[number, 'long' | 'short']>) {
  const s = storeFor(key, (k) => new RegistryStore<ArevPoint>(k, (p) => p as ArevPoint))
  s.ingest(
    signals.map(([date, side]) => point(date, side)),
    { from: 0, to: 1e13 },
    { [GRID_ARRAY]: bars }
  )
  return s
}

/** An hourly chart of `n` bars from 0, which every timeframe below is aligned to. */
const chartBars = (n: number): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: i * H, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1 }) as KLineData)

function config(over: (c: MtfConfig) => void): MtfConfig {
  const c = structuredClone(MTF_DEFAULTS)
  c.timeframes['1h'].enabled = true
  c.timeframes['4h'].enabled = true
  c.graph.roots = { '1D': false, '8h': false, '4h': true, '2h': false, '1h': false }
  over(c)
  return c
}

describe('one calc, from the stores to the markers', () => {
  // (keys are declared below; the hook runs after the file, when they are bound)
  afterAll(async () => {
    const { dropStore } = await import('../plugins/store')
    dropStore(key4h)
    dropStore(key1h)
  })

  // A 4h root top at bar 0 (body top 1.10), one 1h top ABOVE it (1.12, in the graph) and one
  // 1h top below it (1.09, outside). Both are markers; only the first is in the graph.
  const key4h = `arev21_outlier_rank|${SYM}|4h|{"bars":200,"q":0.85,"samples_only":0}|mtf`
  const key1h = `arev21_outlier_rank|${SYM}|1h|{"bars":200,"q":0.85,"samples_only":0}|mtf`

  const extend = (c: MtfConfig) => ({
    seriesKeys: { '4h': key4h, '1h': key1h },
    rev: 1,
    chartInterval: '1h',
    schedule: FX_SCHEDULE,
    config: c,
    graphRoots: ['4h' as const]
  })

  const seed = (): void => {
    store(
      key4h,
      [
        { date: 0, open: 1.09, close: 1.1 },
        { date: 4 * H, open: 1.1, close: 1.1 },
        { date: 8 * H, open: 1.1, close: 1.1 }
      ],
      [[0, 'long']]
    )
    store(
      key1h,
      Array.from({ length: 12 }, (_, i) => ({ date: i * H, open: 1.1, close: i === 5 ? 1.12 : 1.09 })),
      [
        [5 * H, 'long'],
        [7 * H, 'long']
      ]
    )
  }

  test('both signals are drawn, and the graph holds only the one that went further', () => {
    seed()
    const values = computeValues(chartBars(12), extend(config(() => {})))
    const marks = values.flatMap((v, i) => (v.marks ?? []).map((m) => `${m.interval}@bar${i}`))
    expect(marks).toEqual(['4h@bar4', '1h@bar6', '1h@bar8'])
    // The 4h root and the 1h signal above it; the 1h signal at 1.09 is not beyond the root.
    const dots = values.flatMap((v, i) => (v.dots ?? []).map((d) => `${d.interval}@bar${i}${d.root ? ' root' : ''}`))
    expect(dots).toEqual(['4h@bar4 root', '1h@bar6'])
  })

  test('a tick that only moves the forming bar reuses the last result; anything else recomputes', () => {
    seed()
    const data = chartBars(12)
    // Only `extendData` is read, and the object's identity is what the reuse is keyed on.
    const indicator = { extendData: extend(config(() => {})) } as unknown as Indicator<Value, number, ExtendData>
    const first = calc(data, indicator)
    // The forming bar's prices change in place, as klinecharts applies a tick: same result.
    data[11] = { ...data[11], high: 1.2, close: 1.2 }
    expect(calc(data, indicator)).toBe(first)
    expect(first).toEqual(computeValues(data, extend(config(() => {}))))
    // A new bar: klinecharts appends to the same array.
    data.push({ timestamp: 12 * H, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1 } as KLineData)
    const appended = calc(data, indicator)
    expect(appended).not.toBe(first)
    expect(appended.length).toBe(13)
    // A store update reaches the template as a new extendData with the host's new rev.
    indicator.extendData = { ...extend(config(() => {})), rev: 2 }
    const restored = calc(data, indicator)
    expect(restored).not.toBe(appended)
    // A reload or a page of history: klinecharts replaces the array.
    expect(calc([...data], indicator)).not.toBe(restored)
  })

  test('with "hide signals outside the graph" on, only the graph\'s own markers are left', () => {
    seed()
    const values = computeValues(
      chartBars(12),
      extend(
        config((c) => {
          c.graph.onlyGraph = true
        })
      )
    )
    const marks = values.flatMap((v, i) => (v.marks ?? []).map((m) => `${m.interval}@bar${i}`))
    expect(marks).toEqual(['4h@bar4', '1h@bar6'])
  })
})

describe('entries: a graph that reaches 5m draws a star there', () => {
  const M = 60_000
  const ESYM = 'oanda:ZZZENTRY'
  const key = (interval: string) => `arev21_outlier_rank|${ESYM}|${interval}|{"bars":200,"q":0.85,"samples_only":0}|mtf`
  const keys = { '1h': key('1h'), '15m': key('15m'), '5m': key('5m') }

  afterAll(async () => {
    const { dropStore } = await import('../plugins/store')
    for (const k of Object.values(keys)) dropStore(k)
  })

  /** `n` bars of `step` from 0, each body flat at 1.09 except the ones `tops` raises. */
  const grid = (step: number, n: number, tops: Record<number, number>) =>
    Array.from({ length: n }, (_, i) => ({ date: i * step, open: 1.09, close: tops[i] ?? 1.09 }))

  test('a 1h root -> 15m -> 5m -> 5m path: both 5m steps are stars, nothing above them is', () => {
    // 1h root top at 0 (body top 1.10), known at 1h; a 15m top at 1.11 known at 105m; a 5m top
    // at 1.12 known at 130m, and a second at 1.13 known at 155m that supersedes it.
    store(keys['1h'], grid(H, 4, { 0: 1.1 }), [[0, 'long']])
    store(keys['15m'], grid(15 * M, 16, { 6: 1.11 }), [[6 * 15 * M, 'long']])
    store(keys['5m'], grid(5 * M, 48, { 25: 1.12, 30: 1.13 }), [
      [25 * 5 * M, 'long'],
      [30 * 5 * M, 'long']
    ])
    const c = structuredClone(MTF_DEFAULTS)
    for (const interval of ['1h', '15m', '5m'] as const) c.timeframes[interval].enabled = true
    c.graph.roots = { '1D': false, '8h': false, '4h': false, '2h': false, '1h': true }
    const bars = Array.from(
      { length: 48 },
      (_, i) => ({ timestamp: i * 5 * M, open: 1.1, high: 1.1, low: 1.1, close: 1.1, volume: 1 }) as KLineData
    )
    const values = computeValues(
      bars,
      { seriesKeys: keys, rev: 1, chartInterval: '5m', schedule: FX_SCHEDULE, config: c, graphRoots: ['1h'] },
    )
    const dots = values.flatMap((v, i) =>
      (v.dots ?? []).map((d) => `${d.interval}@bar${i}${d.root ? ' root' : ''}${d.entry ? ' entry' : ''}`)
    )
    expect(dots).toEqual(['1h@bar12 root', '15m@bar21', '5m@bar26 entry', '5m@bar31 entry'])
  })
})
