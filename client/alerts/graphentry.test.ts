import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// THE ALERT'S GRAPH IS THE OVERLAY'S GRAPH. Since wdashboard-server 0.56.0 both are the server's
// (`GET /mtf/graph`): the engine asks for exactly what a pane asks for -- the overlay's own
// family and params, the timeframes, the roots, the largest step -- and keeps the entries on its
// timeframe. These tests hold the asking and the keeping; what a graph is, is the server's to
// test (tests/services/test_mtfgraph.py).

installWindow()
const { GraphEntryEngine, graphSettingsOf, entryIntervals, finalThrough } = await import('./graphentry')
const { MTF_DEFAULTS } = await import('../mtf/config')
const { AREV21_OUTLIER_RANK_85_MTF } = await import('../mtf/overlays')
const { FX_GRID } = await import('../replay/timeframes')
import type { MtfGraphAnswer, MtfGraphRequest, MtfNodeRow } from '../mtf/api'
import type { GraphData, GraphOperand } from './graphentry'

const M = 60_000
const H = 60 * M
const SYM = 'oanda:ZZZGRAPH'
// A Monday, so every bar below is a market bar on the FX week.
const T0 = Date.parse('2026-10-05T13:00Z')

const node = (interval: string, date: number, knownAt: number, root: string, entry: boolean, side: 'top' | 'bottom' = 'top'): MtfNodeRow => ({
  interval,
  date,
  knownAt,
  price: 1.1,
  root,
  graph: 0,
  side,
  entry,
  parent: entry ? { interval: '15m', date: T0, knownAt: T0 + 15 * M, price: 1.09 } : null
})

/** A 1h root -> 15m -> 5m -> 5m path, both 5m steps entries -- and the same two 5m signals again
 * as entries of an 8h root's graph, which an alert must count once. */
const NODES = [
  node('1h', T0, T0 + H, '1h', false),
  node('5m', T0 + 25 * 5 * M, T0 + 26 * 5 * M, '1h', true),
  node('5m', T0 + 30 * 5 * M, T0 + 31 * 5 * M, '1h', true),
  node('5m', T0 + 25 * 5 * M, T0 + 26 * 5 * M, '8h', true),
  node('5m', T0 + 30 * 5 * M, T0 + 31 * 5 * M, '8h', true),
  node('3m', T0 + 40 * 3 * M, T0 + 41 * 3 * M, '1h', true)
]

class FakeGraphData implements GraphData {
  requests: MtfGraphRequest[] = []
  constructor(
    private readonly computedThrough: number | null = T0 + 48 * 5 * M - 1,
    private readonly pageSize = Number.POSITIVE_INFINITY
  ) {}
  async grid() {
    return FX_GRID
  }
  async graph(request: MtfGraphRequest): Promise<MtfGraphAnswer> {
    this.requests.push(request)
    const inWindow = NODES.filter((n) => n.knownAt >= request.from && n.knownAt < request.to)
    const instants = [...new Set(inWindow.map((n) => n.knownAt))].sort((a, b) => a - b)
    const cut = instants.length > this.pageSize ? instants[this.pageSize] : null
    return {
      signals: [],
      nodes: cut === null ? inWindow : inWindow.filter((n) => n.knownAt < cut),
      nextFrom: cut,
      computedThrough: this.computedThrough
    }
  }
}

const operand: GraphOperand = {
  kind: 'graph',
  interval: '5m',
  overlay: AREV21_OUTLIER_RANK_85_MTF.id,
  timeframes: ['5m', '15m', '1h', '8h'],
  roots: ['1h', '8h'],
  maxStep: 8
}
const END = T0 + 48 * 5 * M

describe('GraphEntryEngine', () => {
  test("asks the server for exactly what the overlay's pane asks for", async () => {
    const data = new FakeGraphData()
    await new GraphEntryEngine(data).entries(SYM, operand, T0, END)
    expect(data.requests[0]).toEqual({
      symbol: SYM,
      source: AREV21_OUTLIER_RANK_85_MTF.source,
      params: AREV21_OUTLIER_RANK_85_MTF.params,
      timeframes: ['5m', '15m', '1h', '8h'],
      roots: ['1h', '8h'],
      maxStep: 8,
      from: T0,
      to: END,
      // An alert reads past a replay's clock: its look-ahead is what the clock would hide.
      asof: null
    })
  })

  test("keeps the entries on its timeframe, once each however many graphs hold them", async () => {
    const found = await new GraphEntryEngine(new FakeGraphData()).entries(SYM, operand, T0, END)
    expect(found.points).toEqual([
      { date: T0 + 25 * 5 * M, signal: 'top' },
      { date: T0 + 30 * 5 * M, signal: 'top' }
    ])
    // The newest 5m bar final: the last one closed by the server's computed-through instant.
    expect(found.through).toBe(T0 + 46 * 5 * M)
  })

  test('follows the pages, and finds the same entries', async () => {
    const data = new FakeGraphData(T0 + 48 * 5 * M - 1, 1)
    const found = await new GraphEntryEngine(data).entries(SYM, operand, T0, END)
    expect(data.requests.length).toBeGreaterThan(2)
    expect(found.points.map((p) => p.date)).toEqual([T0 + 25 * 5 * M, T0 + 30 * 5 * M])
  })

  test('a 3m entry is not a 5m one, and with no root among the timeframes nothing is asked', async () => {
    const data = new FakeGraphData()
    const engine = new GraphEntryEngine(data)
    const threes = await engine.entries(SYM, { ...operand, interval: '3m', timeframes: [...operand.timeframes, '3m'] }, T0, END)
    expect(threes.points.map((p) => p.date)).toEqual([T0 + 40 * 3 * M])
    const before = data.requests.length
    expect((await engine.entries(SYM, { ...operand, roots: ['4h'] }, T0, END)).points).toEqual([])
    expect(data.requests.length).toBe(before)
  })

  test('nothing is final past what the server has computed, nor past the window read', async () => {
    // The server is final only through 02:25 into the window: the 5m bar closing then is the
    // last final one.
    const short = await new GraphEntryEngine(new FakeGraphData(T0 + 29 * 5 * M - 1)).entries(SYM, operand, T0, END)
    expect(short.through).toBe(T0 + 27 * 5 * M)
    // The server has computed further than the window asked for: final only through the window.
    const window = await new GraphEntryEngine(new FakeGraphData(T0 + 100 * H)).entries(SYM, operand, T0, T0 + 20 * 5 * M)
    expect(window.through).toBe(T0 + 18 * 5 * M)
    // A server that cannot say: nothing is final.
    expect((await new GraphEntryEngine(new FakeGraphData(null)).entries(SYM, operand, T0, END)).through).toBeNull()
  })
})

describe('finalThrough', () => {
  test('the newest bar of the interval whose close is at or before the instant', () => {
    expect(finalThrough('5m', T0 + 10 * M - 1, FX_GRID)).toBe(T0 + 5 * M - 5 * M)
    expect(finalThrough('5m', T0 + 10 * M, FX_GRID)).toBe(T0 + 5 * M)
    expect(finalThrough('5m', null, FX_GRID)).toBeNull()
  })

  test("across the weekend: the week's bars final, the reopening's first bar not", () => {
    // Final just short of the first Sunday bar's close (17:00 New York, 21:00Z): every bar of the
    // week before is final, the one that reopened it is not yet.
    const through = finalThrough('5m', Date.parse('2026-10-11T21:05Z') - 1, FX_GRID) as number
    expect(through).toBeGreaterThanOrEqual(Date.parse('2026-10-09T20:55Z'))
    expect(through).toBeLessThan(Date.parse('2026-10-11T21:00Z'))
  })
})

describe("as a replay's Next alert finds it", () => {
  test("stops at each starred bar's close, and nowhere else", async () => {
    const { AlertSearch } = await import('./search')
    const fake = new FakeGraphData()
    const data = {
      grid: () => fake.grid(),
      graph: (r: MtfGraphRequest) => fake.graph(r),
      bars: async (_s: string, interval: string, from: number, to: number) => {
        const step = interval === '5m' ? 5 * M : interval === '15m' ? 15 * M : H
        const out = []
        for (let open = Math.ceil((from - T0) / step) * step + T0; open < to && open < END; open += step) {
          out.push({ open, end: open + step, date: open, o: 1.1, h: 1.1, l: 1.1, c: 1.1, v: 1 })
        }
        return out
      },
      points: async () => []
    }
    const search = new AlertSearch(data, async () => ({ stored: [], signals: [] }))
    const alert = {
      id: 'g', kind: 'client' as const, name: 'entry', note: '', enabled: true, symbol: SYM,
      rule: { left: operand, op: '==', right: { label: '*' } }, trigger: 'level' as const, repeat: 'always' as const,
      cooldownMs: 0, createdAt: 0, updatedAt: 0, armedAt: 0, status: 'armed' as const, lastFiredAt: null, fireCount: 0
    }
    const first = await search.next(alert, T0, END)
    expect(first?.at).toBe(T0 + 26 * 5 * M)
    const second = await search.next(alert, first?.at ?? 0, END)
    expect(second?.at).toBe(T0 + 31 * 5 * M)
    expect(await search.next(alert, second?.at ?? 0, END)).toBeNull()
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
