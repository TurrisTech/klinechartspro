import { afterAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// THE ALERT'S GRAPH IS THE OVERLAY'S GRAPH. The same scenario `mtf/values.test.ts` pins for the
// chart (a 1h root -> 15m -> 5m -> 5m path, both 5m steps starred) is served to the alert's
// engine as the server would serve it -- a vote on every bar, labelled on the signal bars -- and
// the engine must find exactly the stars the chart draws.

installWindow()
const { GraphEntryEngine, graphSettingsOf, entryIntervals } = await import('./graphentry')
const { computeValues } = await import('../mtf/templates')
const { MTF_DEFAULTS } = await import('../mtf/config')
const { storeFor } = await import('../plugins/store')
const { RegistryStore, GRID_ARRAY } = await import('../tsregistry/store')
const { FX_GRID, FX_SCHEDULE } = await import('../replay/timeframes')
import type { KLineData } from 'klinecharts'
import type { ArevPoint } from '../arev/api'
import type { MtfOverlay } from '../mtf/overlays'
import type { AlertBar } from './compute'
import type { GraphData, GraphOperand } from './graphentry'

const M = 60_000
const H = 60 * M
const SYM = 'oanda:ZZZGRAPH'

/** `n` bars of `step` from 0, each body flat at 1.09 except the ones `tops` raises, and the
 * bars `signals` labels long. */
function series(step: number, n: number, tops: Record<number, number>, signals: number[]) {
  const bars: AlertBar[] = Array.from({ length: n }, (_, i) => {
    const c = tops[i] ?? 1.09
    return { open: i * step, end: (i + 1) * step, date: i * step, o: 1.09, h: Math.max(1.09, c), l: 1.09, c, v: 1 }
  })
  const votes: ArevPoint[] = bars.map((b, i) => ({ date: b.date, p: 0.5, signal: signals.includes(i) ? 'long' : null }) as unknown as ArevPoint)
  return { bars, votes }
}

const DATA = {
  '1h': series(H, 4, { 0: 1.1 }, [0]),
  '15m': series(15 * M, 16, { 6: 1.11 }, [6]),
  '5m': series(5 * M, 48, { 25: 1.12, 30: 1.13 }, [25, 30])
} as Record<string, { bars: AlertBar[]; votes: ArevPoint[] }>

class FakeGraphData implements GraphData {
  reads = 0
  constructor(private readonly upTo: Record<string, number> = {}) {}
  async grid() {
    return FX_GRID
  }
  async bars(_s: string, interval: string, from: number, to: number) {
    this.reads++
    return (DATA[interval]?.bars ?? []).filter((b) => b.open >= from && b.open < to)
  }
  async votes(_o: MtfOverlay, _s: string, interval: string, from: number, to: number) {
    const limit = this.upTo[interval] ?? Number.POSITIVE_INFINITY
    return (DATA[interval]?.votes ?? []).filter((v) => v.date >= from && v.date < to && v.date <= limit)
  }
}

const operand: GraphOperand = {
  kind: 'graph',
  interval: '5m',
  overlay: 'mtf_arev21_outlier_rank_85',
  timeframes: ['5m', '15m', '1h'],
  roots: ['1h'],
  maxStep: 8
}

describe('GraphEntryEngine', () => {
  test('finds exactly the stars the chart draws', async () => {
    const engine = new GraphEntryEngine(new FakeGraphData())
    const found = await engine.entries(SYM, operand, 0, 48 * 5 * M)
    expect(found.points).toEqual([
      { date: 25 * 5 * M, signal: 'top' },
      { date: 30 * 5 * M, signal: 'top' }
    ])
    // Every timeframe served through its last bar: the whole 5m grid is final.
    expect(found.through).toBe(47 * 5 * M)
  })

  test('the chart, on the same data, stars the same two bars', () => {
    // The overlay's own calc over stores holding the same votes and bodies.
    const ingest = (interval: string): string => {
      const key = `chart|${SYM}|${interval}`
      const store = storeFor(key, (k) => new RegistryStore(k, (p) => p)) as InstanceType<typeof RegistryStore>
      const { bars, votes } = DATA[interval]
      store.ingest(votes as never, { from: 0, to: 10 * H }, { [GRID_ARRAY]: bars.map((b) => ({ date: b.date, open: b.o, close: b.c })) })
      return key
    }
    const keys = { '1h': ingest('1h'), '15m': ingest('15m'), '5m': ingest('5m') }
    const config = structuredClone(MTF_DEFAULTS)
    for (const interval of ['1h', '15m', '5m'] as const) config.timeframes[interval].enabled = true
    config.graph.roots = { '1D': false, '8h': false, '4h': false, '2h': false, '1h': true }
    const chartBars = DATA['5m'].bars.map((b) => ({ timestamp: b.open, open: b.o, high: b.h, low: b.l, close: b.c, volume: 1 }) as KLineData)
    const values = computeValues(chartBars, { seriesKeys: keys, rev: 1, chartInterval: '5m', schedule: FX_SCHEDULE, config, graphRoots: ['1h'] })
    const stars = values.flatMap((v, i) => (v.dots ?? []).filter((d) => d.entry).map(() => i))
    // A star sits on the chart bar where the signal became knowable: one past its own bar.
    expect(stars).toEqual([26, 31])
  })

  test('the answer does not depend on where the window starts', async () => {
    const engine = new GraphEntryEngine(new FakeGraphData())
    const late = await engine.entries(SYM, operand, 100 * M, 48 * 5 * M)
    expect(late.points.map((p) => p.date)).toEqual([25 * 5 * M, 30 * 5 * M])
  })

  test('a 5m signal no graph reaches is not an entry, and a 3m entry is not a 5m one', async () => {
    const engine = new GraphEntryEngine(new FakeGraphData())
    // No root among the timeframes: nothing roots a graph.
    expect((await engine.entries(SYM, { ...operand, roots: ['4h'] }, 0, 48 * 5 * M)).points).toEqual([])
    // Asking for 3m entries over a graph that has none on 3m.
    expect((await engine.entries(SYM, { ...operand, interval: '3m', timeframes: [...operand.timeframes, '3m'] }, 0, 48 * 5 * M)).points).toEqual([])
  })

  test('nothing is final past a timeframe the server has not served yet', async () => {
    // The 15m series stops at its bar 8 (02:00 -- 02:15): its next signal could become knowable
    // at 02:30, so the last final 5m bar is the one closing at 02:25 -- the 02:30 close could
    // still meet a 15m signal arriving at the same instant.
    const engine = new GraphEntryEngine(new FakeGraphData({ '15m': 8 * 15 * M }))
    const found = await engine.entries(SYM, operand, 0, 48 * 5 * M)
    expect(found.through).toBe(28 * 5 * M)
    expect(found.points.map((p) => p.date)).toEqual([25 * 5 * M, 30 * 5 * M])
  })
})

describe('a timeframe with no data at all', () => {
  test('puts nothing in the graph and holds nothing back', async () => {
    const engine = new GraphEntryEngine(new FakeGraphData())
    // 3m is read but served nothing: the answer, and how far it is final, are unchanged.
    const found = await engine.entries(SYM, { ...operand, timeframes: ['3m', ...operand.timeframes] }, 0, 48 * 5 * M)
    expect(found.points.map((p) => p.date)).toEqual([25 * 5 * M, 30 * 5 * M])
    expect(found.through).toBe(47 * 5 * M)
  })
})

describe('as a replay\'s Next alert finds it', () => {
  test('stops at each starred bar\'s close, and nowhere else', async () => {
    const { AlertSearch } = await import('./search')
    const fake = new FakeGraphData()
    const data = {
      grid: () => fake.grid(),
      bars: (s: string, i: string, f: number, t: number) => fake.bars(s, i, f, t),
      votes: (o: MtfOverlay, s: string, i: string, f: number, t: number) => fake.votes(o, s, i, f, t),
      points: async () => []
    }
    const search = new AlertSearch(data, async () => ({ stored: [], signals: [] }))
    const alert = {
      id: 'g', kind: 'client' as const, name: 'entry', note: '', enabled: true, symbol: SYM,
      rule: { left: operand, op: '==', right: { label: '*' } }, trigger: 'level' as const, repeat: 'always' as const,
      cooldownMs: 0, createdAt: 0, updatedAt: 0, armedAt: 0, status: 'armed' as const, lastFiredAt: null, fireCount: 0
    }
    const end = 48 * 5 * M
    const first = await search.next(alert, 0, end)
    expect(first?.at).toBe(26 * 5 * M)
    const second = await search.next(alert, first?.at ?? 0, end)
    expect(second?.at).toBe(31 * 5 * M)
    expect(await search.next(alert, second?.at ?? 0, end)).toBeNull()
  })
})

describe('settings', () => {
  test('a pane config becomes the timeframes it has on, its roots among them, its step', () => {
    const config = structuredClone(MTF_DEFAULTS)
    config.timeframes['5m'].enabled = true
    config.graph.roots = { '1D': true, '8h': false, '4h': false, '2h': false, '1h': true }
    config.graph.maxStep = 12
    const settings = graphSettingsOf(config, 'pane 2')
    expect(settings.timeframes).toContain('5m')
    expect(settings.roots).toEqual(['1D', '1h'])
    expect(settings.maxStep).toBe(12)
    expect(settings.from).toBe('pane 2')
  })

  test('with no pane to copy, every timeframe is read and graphs root at 1D', async () => {
    const { defaultGraphSettings } = await import('./graphentry')
    const settings = defaultGraphSettings()
    expect(settings.timeframes).toEqual(['3m', '5m', '15m', '20m', '30m', '1h', '2h', '4h', '8h', '1D'])
    expect(settings.roots).toEqual(['1D'])
  })

  test('an entry is on the overlay 3m or 5m', () => {
    expect(entryIntervals()).toEqual(['3m', '5m'])
  })
})

afterAll(async () => {
  const { dropStore } = await import('../plugins/store')
  for (const interval of ['1h', '15m', '5m']) dropStore(`chart|${SYM}|${interval}`)
})
