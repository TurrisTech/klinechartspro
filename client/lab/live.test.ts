import { describe, expect, test } from 'bun:test'

// THE LAB AGAINST THE OVERLAY'S GRAPH, on a real server: a long and a short rule from one root,
// every slot at the rank 85 overlay's setting, must enter on exactly the 5m and 3m signals the
// alert manager's graph-entry engine finds for that root -- which reads the overlay's graph as the
// server builds it (`GET /mtf/graph`, wdashboard-server 0.56.0). The lab reads `/signals` and its
// candles and builds in the browser: two implementations, one answer.
//
// Root by root since rules (2026-10-20): a rule is one root, and rules do not share a graph, so
// the overlay with SEVERAL roots -- where a signal stepping in a longer root's graph roots nothing
// in a shorter one -- is no longer something a strategy builds.
//
// Opt-in, like client/replay/e2e.test.ts: `LAB_LIVE=http://127.0.0.1:20002 bun test client/lab/live.test.ts`
// against a wdashboard-server with arev21 rows (the dev stack). Passed 2026-10-15 on dev EURUSD,
// 30 days, three root sets (28/3, 4/3 and 28/3 entries) against the client-built graph, and again
// 2026-10-20 against the server's.

const BASE_URL = process.env.LAB_LIVE

describe.skipIf(!BASE_URL)('the lab against the graph-entry engine (real server)', () => {
  test('the same entries, root by root', async () => {
    const g = globalThis as Record<string, unknown>
    g.window = { location: { origin: BASE_URL, href: `${BASE_URL}/`, search: '' }, navigator: { userAgent: 'test' }, OHLCV_BASE_URL: BASE_URL }
    const { loadCapabilities } = await import('../capabilities')
    await loadCapabilities()
    const { HttpLabData } = await import('./data')
    const { runStrategy } = await import('./runner')
    const { rank85Strategy, RANK_TIMEFRAMES } = await import('./model')
    const { withRules } = await import('./testdata')
    const { GraphEntryEngine } = await import('../alerts/graphentry')
    const { HttpAlertData } = await import('../alerts/data')
    const symbol = process.env.LAB_LIVE_SYMBOL ?? 'oanda:EURUSD'
    const to = Date.now()
    const from = to - 30 * 86_400_000
    let compared = 0
    for (const root of ['1D', '8h', '4h', '2h', '1h']) {
      const strategy = withRules(rank85Strategy(), [root], RANK_TIMEFRAMES)
      strategy.instrument = symbol
      const roots = [root]
      const run = await runStrategy(strategy, new HttpLabData(), { from, to, catalogue: null, simulate: false })
      const engine = new GraphEntryEngine(new HttpAlertData())
      for (const interval of ['5m', '3m']) {
        const operand = { kind: 'graph' as const, interval, overlay: 'mtf_arev21_outlier_rank_85', timeframes: [...RANK_TIMEFRAMES], roots, maxStep: 8 }
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
