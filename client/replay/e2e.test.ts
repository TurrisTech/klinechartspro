import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import type { ChartProPane, Period, SymbolInfo } from '../../src'

// End-to-end against a REAL wdashboard-server (the local file-store stack:
// `bin/dev-stack.sh`), with a fake multi-pane wall whose charts implement exactly what
// klinecharts' updateData does (replace the bar at the same timestamp, append a newer one,
// ignore an older one) and whose init load runs ChartPane's own window arithmetic through
// the replay datafeed. Everything else -- the hub, the session, the caches, the engine, the
// signal book, the /sim persistence -- is the shipped code.
//
// Skipped unless REPLAY_E2E names the server (e.g. REPLAY_E2E=http://127.0.0.1:20002).

const BASE_URL = process.env.REPLAY_E2E

const g = globalThis as { window?: unknown; document?: unknown }
if (BASE_URL && !g.window) {
  g.window = {
    OHLCV_BASE_URL: BASE_URL,
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

describe.skipIf(!BASE_URL)('bar replay end to end (real server, fake wall)', () => {
  test('step, jump to a signal, refine a fill, persist and restore', async () => {
    const { loadCapabilities, capabilities } = await import('../capabilities')
    const { setReadClock, getReadClock } = await import('../config')
    const { resolutionToPeriod } = await import('../periods')
    const { loadSignalCatalogue } = await import('../plugins/api')
    const { simApi } = await import('../trading/api')
    const { Engine } = await import('./engine')
    const { ReplayFeedHub, HISTORY_WINDOW_BARS } = await import('./feed')
    const { restore } = await import('./persist')
    const { ReplayTradingSession } = await import('./session')
    const { SignalBook } = await import('./signals')
    const { HttpBarSource, HttpSignalSource } = await import('./source')
    const { fromWall, intervalStart, nominalMs, nonWeekendGaps, toWireDate } = await import('./timeframes').then(async (tf) => ({
      ...tf,
      nonWeekendGaps: (await import('./cache')).nonWeekendGaps
    }))

    await loadCapabilities()
    expect(capabilities().features).toContain('asof')
    expect(capabilities().features).toContain('sim')

    const SYMBOL = 'oanda:EURUSD'
    const symbolInfo = { ticker: 'EURUSD', exchange: 'oanda', pricePrecision: 5 } as unknown as SymbolInfo
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
      feed.subscribe(symbolInfo, period, (bar) => chart.updateData(bar))
      panes.push({
        id: `p${interval}`,
        getChart: () => chart as unknown as ReturnType<ChartProPane['getChart']>,
        getSymbol: () => symbolInfo,
        setSymbol: () => {},
        getPeriod: () => period,
        setPeriod: () => {},
        getDatafeed: () => feed,
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
    const catalogue = await loadSignalCatalogue()
    const arev = catalogue.find((e) => e.ref === 'arev:arev21:long' && e.available)
    const signals = new SignalBook(catalogue, new HttpSignalSource())
    const created = await simApi.create({ mode: 'replay', balance: 10_000, symbol: SYMBOL })
    let rev = created.session.rev
    const saves: number[] = []
    const barSource = new HttpBarSource()
    const fetchLog: string[] = []
    const origFetch = barSource.fetch.bind(barSource)
    barSource.fetch = async (s, i, f, t, c) => {
      fetchLog.push(i)
      return origFetch(s, i, f, t, c)
    }
    const session = new ReplayTradingSession({
      id: created.session.id,
      name: created.session.name,
      createdAt: created.session.createdAt,
      vendor: 'oanda',
      symbol: SYMBOL,
      cursor: start,
      startedAt: start,
      base,
      advance: { interval: '15m', multiple: 1 },
      pauseOnFill: false,
      storedIntervals: ['5s', '1m', '1h', '1D'],
      engine: new Engine(10_000),
      signals,
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

    // -- 1. one 15m step: every pane advances consistently, from base bars ----------------------
    const before = new Map(intervals.map((i) => [i, (charts.get(i) as FakeChart).getDataList().length]))
    const step = await session.step()
    expect(step?.reason).toBe('target')
    expect(session.cursor).toBe(start + 15 * 60_000)
    expect(step?.bars.length).toBeGreaterThan(10) // ~15 one-minute bars (dead minutes may be absent)
    expect(getReadClock()).toBe(session.cursor)
    // 15m pane: a whole new 15m bar (10:00-10:15) closed exactly at the cursor.
    const c15 = charts.get('15m') as FakeChart
    expect(c15.getDataList().length).toBe((before.get('15m') as number) + 1)
    expect(c15.getDataList().at(-1)?.timestamp).toBe(start)
    // 1h / 4h panes: their forming bar (10:00 / 09:00 bucket) updated, count unchanged.
    expect((charts.get('1h') as FakeChart).getDataList().at(-1)?.timestamp).toBe(start)
    expect((charts.get('4h') as FakeChart).getDataList().at(-1)?.timestamp).toBe(intervalStart('4h', start))
    // The quote is the last base bar's close on both sides.
    const q = session.snapshot.quotes[SYMBOL]
    expect(q.ask).toBeGreaterThan(q.bid)

    // -- 2. rest a limit and a stop inside the coming hours; a coarse advance descends -------------
    // Peek the coming three hours (the harness may; the engine may not) and rest a buy limit
    // just above the lowest ask and a sell stop just below the lowest bid they reach -- both
    // inside the band a 1m base bar will present, so the intersection rule must descend.
    const ahead = await new HttpBarSource().fetch(SYMBOL, '1h', session.cursor, session.cursor + 3 * H, 'all')
    expect(ahead.length).toBeGreaterThan(0)
    const askLow = Math.min(...ahead.map((b) => b.ask?.l as number))
    const bidLow = Math.min(...ahead.map((b) => b.bid?.l as number))
    expect(askLow).toBeLessThan(q.ask)
    const limitPx = Number((askLow + 0.00005).toFixed(5))
    const stopPx = Number((bidLow + 0.00005).toFixed(5))
    await session.placeOrder({ symbol: SYMBOL, side: 'buy', type: 'limit', units: 1000, price: limitPx })
    await session.placeOrder({ symbol: SYMBOL, side: 'sell', type: 'stop', units: 1000, price: stopPx, takeProfit: Number((stopPx - 0.005).toFixed(5)) })
    fetchLog.length = 0
    const adv = await session.advanceBy({ interval: '1h', multiple: 3 })
    expect(adv?.reason).toBe('target')
    console.info('[e2e] 3h advance:', adv?.bars.length, 'base bars,', adv?.events.map((e) => `${e.kind}@${e.price}`), 'fetched:', [...new Set(fetchLog)])
    expect(session.cursor).toBe(start + 3 * H) // 3 whole hours from 10:15: 11:00, 12:00, 13:00
    // Both filled, and the engine descended from the 1m base to the 5s bars to do it.
    expect(adv?.events.filter((e) => e.kind === 'fill').length).toBe(2)
    expect(fetchLog).toContain('5s')
    for (const o of session.snapshot.orders) {
      expect(o.status).toBe('filled')
      expect(o.filledAt as number).toBeLessThanOrEqual(session.cursor)
      expect(o.filledAt as number).toBeGreaterThan(start)
      // Stamped on a 5s bar (not a 1m bar's open): the fill instant is on the 5s grid.
      expect(((o.filledAt as number) - start) % 5000).toBe(0)
    }
    const limitOrder = session.snapshot.orders.find((o) => o.type === 'limit')
    expect(limitOrder?.fillPrice as number).toBeLessThanOrEqual(limitPx)

    // -- 3. jump to the next armed signal: every pane grows by the full intermediate count ---------
    const jumpFrom = session.cursor
    let target: number
    if (arev) {
      signals.arm(arev.ref, '1h')
      const jump = await session.nextSignal()
      expect(['signal', 'end']).toContain(jump?.reason ?? '')
      target = session.cursor
      console.info('[e2e] next signal:', jump?.reason, jump?.signal, 'bars:', jump?.bars.length)
      if (jump?.reason === 'signal') expect(jump.signal?.effective).toBe(target)
    } else {
      // No published arev on this store: a long plain advance exercises the same path.
      const jump = await session.advanceBy({ interval: '4h', multiple: 30 })
      expect(jump?.reason).toBe('target')
      target = session.cursor
    }
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
        })
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
    expect(stored?.armed.length).toBe(arev ? 1 : 0)
    const again = Engine.fromState((stored as NonNullable<typeof stored>).engine)
    expect(again.balance).toBe(session.snapshot.account.balance)
    await simApi.remove(created.session.id)
    setReadClock(null)
  }, 120_000)
})
