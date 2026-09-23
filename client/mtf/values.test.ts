import { afterAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// What one `calc` produces from real stores: the markers, the graphs over them, and the
// "hide signals outside the graph" filter -- the path the pane actually renders, driven here
// end to end rather than through its pieces.
installWindow()
const { computeValues } = await import('./templates')
const { AREV21_OUTLIER_RANK_85_MTF } = await import('./overlays')
const { MTF_DEFAULTS } = await import('./config')
const { GRID_ARRAY, RegistryStore } = await import('../tsregistry/store')
const { storeFor } = await import('../plugins/store')
const { drawsSignal, resetDrawn } = await import('./drawn')

import type { ArevPoint } from '../arev/api'
import type { KLineData } from 'klinecharts'
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
    resetDrawn()
  })

  // A 4h root top at bar 0 (body top 1.10), one 1h top ABOVE it (1.12, in the graph) and one
  // 1h top below it (1.09, outside). Both are markers; only the first is in the graph.
  const key4h = `arev21_outlier_rank|${SYM}|4h|{"bars":200,"q":0.85,"samples_only":0}|mtf`
  const key1h = `arev21_outlier_rank|${SYM}|1h|{"bars":200,"q":0.85,"samples_only":0}|mtf`

  const extend = (c: MtfConfig) => ({
    seriesKeys: { '4h': key4h, '1h': key1h },
    rev: 1,
    chartInterval: '1h',
    config: c,
    graphRoots: ['4h' as const],
    symbol: SYM
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
    const values = computeValues(chartBars(12), extend(config(() => {})), AREV21_OUTLIER_RANK_85_MTF)
    const marks = values.flatMap((v, i) => (v.marks ?? []).map((m) => `${m.interval}@bar${i}`))
    expect(marks).toEqual(['4h@bar4', '1h@bar6', '1h@bar8'])
    // The 4h root and the 1h signal above it; the 1h signal at 1.09 is not beyond the root.
    const dots = values.flatMap((v, i) => (v.dots ?? []).map((d) => `${d.interval}@bar${i}${d.root ? ' root' : ''}`))
    expect(dots).toEqual(['4h@bar4 root', '1h@bar6'])
  })

  test('with "hide signals outside the graph" on, only the graph\'s own markers are left', () => {
    seed()
    const values = computeValues(
      chartBars(12),
      extend(
        config((c) => {
          c.graph.onlyGraph = true
        })
      ),
      AREV21_OUTLIER_RANK_85_MTF
    )
    const marks = values.flatMap((v, i) => (v.marks ?? []).map((m) => `${m.interval}@bar${i}`))
    expect(marks).toEqual(['4h@bar4', '1h@bar6'])
  })

  test('what it publishes is what it drew, so the replay can ask', () => {
    resetDrawn()
    seed()
    const ref = 'arev21_outlier:arev21_outlier_rank:long'
    computeValues(
      chartBars(12),
      extend(
        config((c) => {
          c.graph.onlyGraph = true
        })
      ),
      AREV21_OUTLIER_RANK_85_MTF
    )
    // Drawn: the 4h root and the 1h signal in the graph. Hidden: the 1h signal outside it.
    expect(drawsSignal(SYM, ref, '4h', 0, 5 * H)).toBe(true)
    expect(drawsSignal(SYM, ref, '1h', 5 * H, 7 * H)).toBe(true)
    expect(drawsSignal(SYM, ref, '1h', 7 * H, 9 * H)).toBe(false)
    // A timeframe this pane does not draw, and a bar it has never placed.
    expect(drawsSignal(SYM, ref, '1D', 0, 5 * H)).toBe(false)
    expect(drawsSignal(SYM, ref, '1h', 99 * H, 5 * H)).toBeNull()
  })
})
