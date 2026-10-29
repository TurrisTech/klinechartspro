import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import type { ChartProPane, Period, SymbolInfo } from '../../src'

// End-to-end against a REAL wdashboard-server and a REAL tile bucket, with a fake multi-pane
// wall whose charts implement exactly what klinecharts' updateData does (replace the bar at the
// same timestamp, append a newer one, ignore an older one) and whose init load runs ChartPane's
// own window arithmetic through the replay datafeed. Everything else -- the hub, the session,
// the tiled bar source the wall gives it (`index.ts`), the caches, the engine, the alert search
// behind Next alert, the /sim persistence -- is the shipped code.
//
// Skipped unless REPLAY_E2E names the server and REPLAY_E2E_TILES the bucket its tiles are read
// from, which the server does not serve (the client's own host proxies /tiles). On this
// workstation, a server over the dev cluster with closed history from the dev bucket, and the
// SeaweedFS port-forward for both (`kubectl -n seaweedfs port-forward svc/seaweedfs-s3 18493:8333`):
//
//   direnv exec /workspace env OHLCV_BACKEND=postgres NATS_URL=disabled \
//     OHLCV_TILES_URL=s3://marketdata-tiles-dev OHLCV_TILES_ENDPOINT=http://127.0.0.1:18493 \
//     uv run uvicorn wdashboard_server.services.ohlcv:app --port 20072 --no-access-log  # in wdashboard-server
//   REPLAY_E2E=http://127.0.0.1:20072 REPLAY_E2E_TILES=http://127.0.0.1:18493/marketdata-tiles-dev \
//     bun test client/replay/e2e.test.ts
//
// Without APPSTATE_DB_* the server keeps /sim sessions in memory, so nothing is written to a
// database. The data is EURUSD on 2024-03-04: 5s, 1m and 1h tiles with their bid/ask halves.
//
// Skipped in `bun test`, it fell out of step with the session without anyone seeing: hours after
// it was written a Step with nothing that could fill came to SEEK rather than walk (`61dfcf7`,
// 2026-08-25), and its first assertion -- fifteen base bars walked -- has failed ever since. The
// walk has since come to SKIM the stored coarser candles rather than hand the engine every base
// bar (`b96cec2`, 2026-10-26), and to read the bucket's tiles rather than `/getbars` (`a33977a`,
// 2026-10-28). It holds all three now, against the real store.

const BASE_URL = process.env.REPLAY_E2E
const TILES_URL = process.env.REPLAY_E2E_TILES

const g = globalThis as { window?: unknown; document?: unknown }
if (BASE_URL && TILES_URL && !g.window) {
  g.window = {
    OHLCV_BASE_URL: BASE_URL,
    TILES_BASE_URL: TILES_URL,
    location: { origin: BASE_URL, href: `${BASE_URL}/`, search: '' },
    navigator: { userAgent: 'test' },
    sessionStorage: null
  }
}

const H = 3_600_000

class FakeChart {
  data: KLineData[] = []
  resets = 0
  getDataList(): KLineData[] {
    return this.data
  }
  updateData(bar: KLineData): void {
    const last = this.data.at(-1)
    if (!last || bar.timestamp > last.timestamp) this.data.push(bar)
    else if (bar.timestamp === last.timestamp) this.data[this.data.length - 1] = bar
  }
  applyNewData(bars: KLineData[]): void {
    this.data = [...bars]
  }
  resetData(): void {
    this.resets++
  }
}

describe.skipIf(!BASE_URL || !TILES_URL)('bar replay end to end (real server, real tiles, fake wall)', () => {
  test('a step seeks, a walk skims and refines a fill, Next alert jumps, the state persists', async () => {
    const { loadCapabilities, capabilities } = await import('../capabilities')
    const { setReadClock, getReadClock } = await import('../config')
    const { resolutionToPeriod } = await import('../periods')
    const { AlertSearch } = await import('../alerts/search')
    const { HttpAlertData } = await import('../alerts/data')
    const { ReplayAlerts } = await import('./alerts')
    const { simApi } = await import('../trading/api')
    const { Engine } = await import('./engine')
    const { ReplayFeedHub, HISTORY_WINDOW_BARS } = await import('./feed')
    const { restore } = await import('./persist')
    const { ReplayTradingSession } = await import('./session')
    const { HttpBarSource } = await import('./source')
    const { TiledBarSource } = await import('./tiled')
    const { FX_GRID, FX_SCHEDULE, fromWall, intervalStart, nominalMs, nonWeekendGaps, toWireDate } = await import('./timeframes').then(async (tf) => ({
      ...tf,
      nonWeekendGaps: (await import('./cache')).nonWeekendGaps
    }))

    await loadCapabilities()
    expect(capabilities().features).toContain('asof')
    expect(capabilities().features).toContain('sim')

    const SYMBOL = 'oanda:EURUSD'
    // The schedule travels on the symbol, as client/symbols.ts resolves it from the server.
    const symbolInfo = { ticker: 'EURUSD', exchange: 'oanda', pricePrecision: 5, timezone: FX_SCHEDULE.timezone, dayGeometry: FX_SCHEDULE.day } as unknown as SymbolInfo
    // Monday 2024-03-04 10:00 New York, a 1m base (1m divides 15m, 1h, 4h).
    const start = fromWall(Date.UTC(2024, 2, 4, 10, 0), 'America/New_York')
    const base = '1m'
    setReadClock(start)

    // -- the wall: 15m + 1h + 4h panes over the replay datafeed ----------------------------
    const hub = new ReplayFeedHub(new HttpBarSource(), base, start)
    const feed = hub.createFeed()
    const intervals = ['15m', '1h', '4h']
    const charts = new Map<string, FakeChart>()
    const panes: ChartProPane[] = []
    const loadPane = async (interval: string): Promise<void> => {
      const period = resolutionToPeriod(interval) as Period
      const to = Date.now()
      const from = to - 500 * nominalMs(interval)
      const bars = await feed.getHistoryKLineData(symbolInfo, period, from, to)
      ;(charts.get(interval) as FakeChart).applyNewData(bars)
    }
    for (const interval of intervals) {
      const chart = new FakeChart()
      charts.set(interval, chart)
      const period = resolutionToPeriod(interval) as Period
      feed.subscribe(symbolInfo, period, (data) => {
        for (const bar of Array.isArray(data) ? data : [data]) chart.updateData(bar)
      })
      panes.push({
        id: `p${interval}`,
        getChart: () => chart as unknown as ReturnType<ChartProPane['getChart']>,
        getSymbol: () => symbolInfo,
        setSymbol: () => {},
        getPeriod: () => period,
        setPeriod: () => {},
        getDatafeed: () => feed,
        seekTo: () => {},
        isActive: () => interval === '1h'
      })
      await loadPane(interval)
      const data = chart.getDataList()
      expect(data.length).toBeGreaterThan(50)
      // Nothing after the cursor, and the forming bar (if any) is the bucket containing it.
      const lastOpen = data.at(-1)?.timestamp as number
      expect(lastOpen).toBeLessThanOrEqual(toWireDate(interval, intervalStart(interval, start - 1)))
    }

    // -- the session ---------------------------------------------------------------------------
    // One client alert, computed in the browser from the stored bars: the 1h close crossing
    // above its 20-bar average, which a few weeks of EURUSD does many times.
    const alert = {
      id: 'e2e', kind: 'client' as const, name: 'close over MA20', note: '', enabled: true, symbol: SYMBOL,
      rule: {
        left: { kind: 'bar' as const, interval: '1h', field: 'close' as const },
        op: 'crosses_above',
        right: { operand: { kind: 'indicator' as const, interval: '1h', name: 'MA', params: [20], output: 'ma1' } }
      },
      trigger: 'level' as const, repeat: 'always' as const, cooldownMs: 0,
      createdAt: 0, updatedAt: 0, armedAt: 0, status: 'armed' as const, lastFiredAt: null, fireCount: 0
    }
    const alerts = new ReplayAlerts(() => [alert], new AlertSearch(new HttpAlertData(), async () => ({ stored: [], signals: [] })))
    const created = await simApi.create({ mode: 'replay', balance: 10_000, symbol: SYMBOL })
    let rev = created.session.rev
    const saves: number[] = []
    // The wall's own bar source: the bucket's tiles, held in memory a tile at a time, and the
    // server only for what no tile covers -- which, for a closed week of 2024, is nothing. Every
    // read the session makes is logged by interval, and every one the tiles had to hand to the
    // server is logged apart.
    const server = new HttpBarSource()
    const toServer: string[] = []
    const origServer = server.fetch.bind(server)
    server.fetch = async (s, i, f, t, c, g) => {
      toServer.push(i)
      return origServer(s, i, f, t, c, g)
    }
    const barSource = new TiledBarSource(server)
    const fetchLog: string[] = []
    const origFetch = barSource.fetch.bind(barSource)
    barSource.fetch = async (s, i, f, t, c, g) => {
      fetchLog.push(i)
      return origFetch(s, i, f, t, c, g)
    }
    const session = new ReplayTradingSession({
      id: created.session.id,
      name: created.session.name,
      createdAt: created.session.createdAt,
      vendor: 'oanda',
      grid: FX_GRID,
      symbol: SYMBOL,
      cursor: start,
      startedAt: start,
      base,
      advance: { interval: '15m', multiple: 1 },
      pauseOnFill: false,
      storedIntervals: ['5s', '1m', '1h', '1D'],
      engine: new Engine(10_000),
      alerts,
      barSource,
      dataEnd: () => start + 30 * 24 * H,
      save: async (state) => {
        const saved = await simApi.putState(created.session.id, rev, state)
        rev = saved.session.rev
        saves.push(state.cursor)
      },
      onAdvanced: async (result) => {
        setReadClock(result.to)
        hub.cursor = result.to
        const reports = await hub.push(panes, result.from)
        for (const r of reports) {
          if (r.reloaded) await loadPane(r.key.split('|')[1])
          expect(r.problem).toBeNull()
        }
      }
    })
    session.setIntervalsInUse(intervals)

    // -- 1. one 15m step with nothing working SEEKS; every pane advances consistently ------------
    // Nothing resting, nothing protected: the account cannot change however the price moves, so
    // the cursor lands at the target with no base bar walked, and the engine is quoted once where
    // it lands -- the state a walk would have left it in.
    const before = new Map(intervals.map((i) => [i, (charts.get(i) as FakeChart).getDataList().length]))
    toServer.length = 0
    const step = await session.step()
    expect(step?.reason).toBe('target')
    expect(session.cursor).toBe(start + 15 * 60_000)
    expect(step?.walked).toBe(false)
    expect(step?.bars).toEqual([])
    expect(step?.events).toEqual([])
    expect(getReadClock()).toBe(session.cursor)
    // The quote is the close of the base bar the cursor landed on, both sides.
    const [landed] = await new HttpBarSource().fetch(SYMBOL, base, session.cursor - 60_000, session.cursor, 'all', FX_GRID)
    expect(landed?.end).toBe(session.cursor)
    // ...read, like everything the session reads here, from the tiles.
    expect(toServer).toEqual([])
    // 15m pane: a whole new 15m bar (10:00-10:15) closed exactly at the cursor.
    const c15 = charts.get('15m') as FakeChart
    expect(c15.getDataList().length).toBe((before.get('15m') as number) + 1)
    expect(c15.getDataList().at(-1)?.timestamp).toBe(start)
    // 1h / 4h panes: their forming bar (10:00 / 09:00 bucket) updated, count unchanged.
    expect((charts.get('1h') as FakeChart).getDataList().at(-1)?.timestamp).toBe(start)
    expect((charts.get('4h') as FakeChart).getDataList().at(-1)?.timestamp).toBe(intervalStart('4h', start))
    const q = session.snapshot.quotes[SYMBOL]
    expect([q.bid, q.ask]).toEqual([landed.bid?.c as number, landed.ask?.c as number])
    expect(q.ask).toBeGreaterThan(q.bid)

    // -- 2. rest a limit and a stop the 11:00 hour reaches; the advance walks, by SKIMMING -----------
    // Peek the coming hours (the harness may; the engine may not) and rest a buy limit just above
    // the lowest ask and a sell stop just above the lowest bid of the 11:00 hour -- prices a 1m base
    // bar's band will hold, so the intersection rule must descend to the 5s bars -- with a take
    // profit below anything the three hours reach. Both have filled by 12:00 at the latest, and
    // from then on nothing can, so every whole hour after the fills is quiet and goes over as one
    // candle. (On the dev store both fill in the first minute, 10:15:20 and 10:15:25, and the 11:00
    // and 12:00 hours both go over whole: 45 minutes and two hours, 47 bars for the 165 a walk hands
    // over.)
    const ahead = await new HttpBarSource().fetch(SYMBOL, '1h', session.cursor, session.cursor + 3 * H, 'all', FX_GRID)
    expect(ahead.map((b) => b.open)).toEqual([start + H, start + 2 * H, start + 3 * H])
    const askLow = ahead[0].ask?.l as number
    const bidLow = ahead[0].bid?.l as number
    expect(askLow).toBeLessThan(q.ask)
    const limitPx = Number((askLow + 0.00005).toFixed(5))
    const stopPx = Number((bidLow + 0.00005).toFixed(5))
    const unreached = Number((Math.min(...ahead.map((b) => b.bid?.l as number)) - 0.005).toFixed(5))
    await session.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', units: 1000, price: limitPx })
    await session.placeOrder({ symbol: SYMBOL, side: 'sell', type: 'stop', units: 1000, price: stopPx, takeProfit: unreached })
    fetchLog.length = 0
    toServer.length = 0
    const adv = await session.advanceBy({ interval: '1h', multiple: 3 })
    expect(adv?.reason).toBe('target')
    console.info('[e2e] 3h advance:', adv?.bars.length, 'bars,', adv?.events.map((e) => `${e.kind}@${e.price}@${new Date(e.time).toISOString()}`), 'fetched:', [...new Set(fetchLog)])
    expect(session.cursor).toBe(start + 3 * H) // 3 whole hours from 10:15: 11:00, 12:00, 13:00
    expect(adv?.walked).toBe(true)
    // Both filled, and the engine descended from the 1m base to the 5s bars to do it.
    expect(adv?.events.filter((e) => e.kind === 'fill').length).toBe(2)
    expect(fetchLog).toContain('5s')
    // The skim: the stored hours were asked first, and each whole one after the last fill went
    // over as one bar, with none of its sixty minutes; the 45 minutes before 11:00 hold no whole
    // hour and are walked minute by minute.
    expect(fetchLog).toContain('1h')
    const consumed = adv?.bars ?? []
    const lastFill = Math.max(...(adv?.events ?? []).filter((e) => e.kind === 'fill').map((e) => e.time))
    expect(lastFill).toBeLessThan(start + 2 * H)
    for (const hour of [start + H, start + 2 * H].filter((h) => h >= lastFill)) {
      expect(consumed.filter((b) => b.open >= hour && b.open < hour + H).map((b) => [b.open, b.end])).toEqual([[hour, hour + H]])
    }
    expect(consumed.filter((b) => b.open < start + H).every((b) => b.end - b.open === 60_000)).toBe(true)
    // The tiles: every bar of it came out of the bucket -- not one read handed to the server.
    expect(toServer).toEqual([])
    for (const o of session.snapshot.orders) {
      expect(o.status).toBe('filled')
      expect(o.filledAt as number).toBeLessThanOrEqual(session.cursor)
      expect(o.filledAt as number).toBeGreaterThan(start)
      // Stamped on a 5s bar (not a 1m bar's open): the fill instant is on the 5s grid.
      expect(((o.filledAt as number) - start) % 5000).toBe(0)
    }
    const limitOrder = session.snapshot.orders.find((o) => o.type === 'limit')
    expect(limitOrder?.fillPrice as number).toBeLessThanOrEqual(limitPx)

    // -- 3. jump to the next alert, then a long advance: every pane grows by the full count --------
    const jumpFrom = session.cursor
    const jump = await session.nextAlert()
    console.info('[e2e] next alert:', jump?.reason, jump?.alert, 'bars:', jump?.bars.length)
    expect(jump?.reason).toBe('alert')
    expect(jump?.alert?.effective).toBe(session.cursor)
    expect(session.cursor).toBeGreaterThan(jumpFrom)
    // An alert triggers at a bar's close: on the 1h grid.
    expect(intervalStart('1h', session.cursor)).toBe(session.cursor)
    await session.advanceBy({ interval: '4h', multiple: 30 })
    const target = session.cursor
    expect(target).toBeGreaterThan(jumpFrom + 4 * H)
    for (const interval of intervals) {
      const chart = charts.get(interval) as FakeChart
      const data = chart.getDataList()
      // What the server says the pane should hold up to the cursor, under the clock.
      const expected = (await feed.getHistoryKLineData(symbolInfo, resolutionToPeriod(interval) as Period, target - HISTORY_WINDOW_BARS * nominalMs(interval), target)).map((b) => b.timestamp)
      const tail = data.slice(-expected.length).map((b) => b.timestamp)
      expect(tail).toEqual(expected)
      // And no non-weekend gap in what the pane holds.
      const gaps = nonWeekendGaps(
        interval,
        data.map((b) => {
          const open = b.timestamp - (interval === '1D' ? 7 * H : 0)
          return { open, end: open, date: b.timestamp, o: 0, h: 0, l: 0, c: 0, v: 0 }
        }),
        FX_GRID
      )
      expect(gaps.filter((gp) => gp.before > jumpFrom - 4 * H)).toEqual([])
    }

    // -- 4. persistence: the blob restores the cursor, orders and trades --------------------------
    await session.flushSaves()
    expect(saves.at(-1)).toBe(session.cursor)
    const fetched = await simApi.get(created.session.id)
    const stored = restore(fetched.session.state)
    expect(stored?.cursor).toBe(session.cursor)
    expect(stored?.engine.orders.length).toBe(session.snapshot.orders.length)
    expect(stored?.engine.trades.length).toBe(session.snapshot.trades.length)
    const again = Engine.fromState((stored as NonNullable<typeof stored>).engine)
    expect(again.balance).toBe(session.snapshot.account.balance)
    await simApi.remove(created.session.id)
    setReadClock(null)
  }, 120_000)
})
