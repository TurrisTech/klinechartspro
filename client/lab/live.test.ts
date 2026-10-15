import { describe, expect, test } from 'bun:test'

// THE LAB AGAINST THE OVERLAY'S OWN CODE, on a real server: a strategy's 5m and 3m entries, with
// every graph slot at the rank 85 overlay's setting, must be exactly the entries the alert
// manager's graph-entry engine finds -- which reads the overlay's own fetch (`/values` plus each
// timeframe's bar grid, knowable at the next bar's open) and runs its own `buildRootGraphs`. The
// lab reads `/signals` and its candles and knows a signal at its close: two data paths, one answer.
//
// Opt-in, like client/replay/e2e.test.ts: `LAB_LIVE=http://127.0.0.1:20002 bun test client/lab/live.test.ts`
// against a wdashboard-server with arev21 rows (the dev stack). Passed 2026-10-15 on dev EURUSD,
// 30 days, three root sets (28/3, 4/3 and 28/3 entries).

const BASE_URL = process.env.LAB_LIVE

describe.skipIf(!BASE_URL)('the lab against the graph-entry engine (real server)', () => {
  test('the same entries, root set by root set', async () => {
    const g = globalThis as Record<string, unknown>
    g.window = { location: { origin: BASE_URL, href: `${BASE_URL}/`, search: '' }, navigator: { userAgent: 'test' }, OHLCV_BASE_URL: BASE_URL }
    const { loadCapabilities } = await import('../capabilities')
    await loadCapabilities()
    const { HttpLabData } = await import('./data')
    const { runStrategy } = await import('./runner')
    const { rank85Strategy } = await import('./model')
    const { GraphEntryEngine } = await import('../alerts/graphentry')
    const { HttpAlertData } = await import('../alerts/data')
    const symbol = process.env.LAB_LIVE_SYMBOL ?? 'oanda:EURUSD'
    const to = Date.now()
    const from = to - 30 * 86_400_000
    let compared = 0
    for (const roots of [['1D', '1h'], ['8h', '4h'], ['1D', '8h', '4h', '2h', '1h']]) {
      const strategy = rank85Strategy()
      strategy.instrument = symbol
      strategy.graph.roots = roots
      const run = await runStrategy(strategy, new HttpLabData(), { from, to, catalogue: null, simulate: false })
      const engine = new GraphEntryEngine(new HttpAlertData())
      for (const interval of ['5m', '3m']) {
        const operand = { kind: 'graph' as const, interval, overlay: 'mtf_arev21_outlier_rank_85', timeframes: strategy.sources[0].timeframes, roots, maxStep: 8 }
        const theirs = await engine.entries(symbol, operand, from, to)
        // The engine lists a signal once per graph it is an entry of; the lab once.
        const expected = [...new Set(theirs.points.map((p) => `${p.date}|${p.signal}`))].sort()
        const ours = run.entries.filter((e) => e.signal.interval === interval).map((e) => `${e.signal.sourceDate}|${e.side}`).sort()
        expect(ours).toEqual(expected)
        compared += ours.length
      }
    }
    expect(compared).toBeGreaterThan(0)
  }, 300_000)
})
