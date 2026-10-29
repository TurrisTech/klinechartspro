import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { KLineData } from 'klinecharts'
import type { ChartProPane, Period, SymbolInfo } from '../../src'
import type { BarSource, Columns, ReplayBar } from './cache'
import { CONTINUOUS_DAY, type CandleGrid } from './timeframes'

// feed.ts reaches config.ts, which reads `window` at import: a DOM for this file only.
GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())
const { ReplayFeedHub } = await import('./feed')
const { resolutionToPeriod } = await import('../periods')

// THE HUB ON ANOTHER MARKET'S CLOCK. Every pane is brought up to the cursor on the schedule of
// the instrument IT shows, so a coinbase pane's forming day is labelled at UTC midnight -- the
// label /getbars gives the whole bar -- and not at the FX week's 17:00 New York. A pane whose
// instrument has no resolved market hours gets no guessed label at all.

const H = 3_600_000
const UTC = (d: number, h = 0): number => Date.UTC(2024, 2, d, h)

/** One bar per hour for the base, one per UTC day for the pane, labelled on the given grid. */
class CryptoSource implements BarSource {
  async fetch(_symbol: string, interval: string, from: number, to: number, _columns: Columns, grid: CandleGrid): Promise<ReplayBar[]> {
    const out: ReplayBar[] = []
    for (let open = grid.start(interval, from); open < to; open = grid.nextStart(interval, open)) {
      if (open < from) continue
      out.push({ open, end: grid.end(interval, open), date: grid.toWire(interval, open), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 })
    }
    return out
  }
}

/** A pane over a chart that keeps klinecharts' updateData semantics: a bar at the last bar's
 * timestamp replaces it, a newer one is appended. */
function pane(symbol: Partial<SymbolInfo>, interval: string, bars: KLineData[]): { pane: ChartProPane; data: KLineData[] } {
  const data = [...bars]
  const callback = (bar: KLineData): void => {
    if (data.at(-1)?.timestamp === bar.timestamp) data[data.length - 1] = bar
    else data.push(bar)
  }
  const fake = {
    id: 'p1',
    getSymbol: () => ({ ticker: 'BTCUSD', exchange: 'coinbase', ...symbol }) as SymbolInfo,
    getPeriod: () => resolutionToPeriod(interval),
    getDatafeed: () => ({ callbackFor: () => callback }),
    getChart: () => ({ getDataList: () => data, resetData: () => {} })
  }
  return { pane: fake as unknown as ChartProPane, data }
}

const bar = (timestamp: number): KLineData => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 })

describe('ReplayFeedHub on a pane\'s own schedule', () => {
  test('a coinbase daily pane forms Saturday\'s candle from UTC midnight, and labels it there', async () => {
    const cursor = UTC(9, 12) // Saturday 12:00 UTC -- inside the FX weekend, a trading day here
    const hub = new ReplayFeedHub(new CryptoSource(), '1h', cursor)
    const { pane: p, data } = pane({ timezone: 'UTC', dayGeometry: CONTINUOUS_DAY }, '1D', [bar(UTC(8))])
    const [report] = await hub.push([p], cursor - H)
    expect(report.problem).toBeNull()
    expect(report.forming).toBe(true)
    // Friday's whole bar (closed at Saturday 00:00) and Saturday's forming one, from 12 hours.
    expect(data.map((b) => b.timestamp)).toEqual([UTC(8), UTC(9)])
    expect(data[1].volume).toBe(12 * 10)
  })

  test('a pane whose instrument has no market hours is refused, not labelled on a guess', async () => {
    const cursor = UTC(9, 12)
    const hub = new ReplayFeedHub(new CryptoSource(), '1h', cursor)
    const { pane: p, data } = pane({}, '1D', [bar(UTC(8))])
    const [report] = await hub.push([p], cursor - H)
    expect(report.problem).toBe('no market hours for coinbase:BTCUSD')
    expect(data.map((b) => b.timestamp)).toEqual([UTC(8)])
  })
})

// THE FORMING CANDLE FROM THE COARSEST STORED BARS. A store whose 1m, 1h and 1D bars are its 5s
// bars aggregated, as prod's are: a jump of a day reads 1h bars from the 17:00 open, 1m bars from
// the hour and 5s bars from the minute -- never the day's 5s bars, nor the gap the jump crossed --
// and the candle is exactly the one the 5s bars make.

const { FX_SCHEDULE, FX_GRID, fromWall } = await import('./timeframes')
const { composeForming } = await import('./cache')

const ny = (d: number, h: number, m = 0, s = 0): number => fromWall(Date.UTC(2024, 2, d, h, m, s), 'America/New_York')

/** Sunday 17 March 17:00 to Thursday 21 March 17:00 New York: 5s bars on a seeded walk, and
 * every coarser interval built from them. No DST change inside it. */
class AggregatedStore implements BarSource {
  readonly calls: Array<{ interval: string; from: number; to: number; bars: number }> = []
  private readonly bars = new Map<string, ReplayBar[]>()

  /** A fresh call log over the same bars (building them is the slow part). */
  fresh(): AggregatedStore {
    const copy = Object.create(AggregatedStore.prototype) as AggregatedStore
    Object.assign(copy, { calls: [], bars: this.bars })
    return copy
  }

  constructor() {
    const s5: ReplayBar[] = []
    let seed = 7
    let px = 1.09
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    for (let open = ny(17, 17); open < ny(21, 17); open += 5_000) {
      // About a third of the 5s buckets have no tick, as on the real store.
      if (rand() < 0.3) continue
      const o = px
      px += (rand() - 0.5) * 0.0002
      const c = px
      s5.push({ open, end: open + 5_000, date: open, o, h: Math.max(o, c) + rand() * 0.00005, l: Math.min(o, c) - rand() * 0.00005, c, v: 1 + Math.floor(rand() * 5) })
    }
    this.bars.set('5s', s5)
    // The grid answers per hour, not per bar: New York's offset is whole hours, so a bar's
    // minute and hour are its UTC ones, and its day is its hour's.
    const days = new Map<number, number>()
    const bucketOf = (interval: string, open: number): number => {
      if (interval === '1m') return open - (open % 60_000)
      const hour = open - (open % H)
      if (interval === '1h') return hour
      const held = days.get(hour)
      if (held !== undefined) return held
      const day = FX_GRID.start('1D', hour)
      days.set(hour, day)
      return day
    }
    for (const interval of ['1m', '1h', '1D']) {
      const out: ReplayBar[] = []
      let bucket: ReplayBar[] = []
      const flush = (): void => {
        out.push(composeForming(interval, bucketOf(interval, bucket[0].open), bucket, FX_GRID) as ReplayBar)
        bucket = []
      }
      for (const b of s5) {
        if (bucket.length > 0 && bucketOf(interval, b.open) !== bucketOf(interval, bucket[0].open)) flush()
        bucket.push(b)
      }
      if (bucket.length > 0) flush()
      this.bars.set(interval, out)
    }
  }

  all(interval: string): ReplayBar[] {
    return this.bars.get(interval) ?? []
  }

  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    const out = this.all(interval).filter((b) => b.open >= from && b.open < to)
    this.calls.push({ interval, from, to, bars: out.length })
    return out
  }
}

/** Two panes of one FX instrument, the way ChartPane's datafeed sees them. */
function fxPane(id: string, interval: string, bars: KLineData[]): { pane: ChartProPane; data: KLineData[] } {
  const made = pane({ ticker: 'EURUSD', exchange: 'oanda', timezone: FX_SCHEDULE.timezone, dayGeometry: FX_SCHEDULE.day }, interval, bars)
  ;(made.pane as unknown as { id: string }).id = id
  return made
}

const STORE = new AggregatedStore()

const asKLine = (b: ReplayBar): KLineData => ({ timestamp: b.date, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })

describe('ReplayFeedHub composes the forming candle from the coarsest stored bars', () => {
  test('a day-long jump reads hours, then minutes, then seconds -- and makes the 5s candle', async () => {
    const store = STORE.fresh()
    const stored = ['5s', '1m', '1h', '1D']
    const before = ny(19, 6, 0, 20) // Tuesday 06:00:20
    const hub = new ReplayFeedHub(store, '5s', before)
    hub.setStored('oanda:EURUSD', stored)
    const day = fxPane('day', '1D', [asKLine(store.all('1D')[0])]) // Monday's session, forming
    const hourBars = store.all('1h').filter((b) => b.open <= ny(19, 5))
    const hour = fxPane('hour', '1h', hourBars.slice(-20).map(asKLine))
    await hub.push([day.pane, hour.pane], before - 5_000)

    // The jump: Tuesday 06:00:20 to Wednesday 06:12:35.
    store.calls.length = 0
    const cursor = ny(20, 6, 12, 35)
    hub.cursor = cursor
    const reports = await hub.push([day.pane, hour.pane], before)
    expect(reports.map((r) => r.problem)).toEqual([null, null])
    expect(reports.map((r) => r.forming)).toEqual([true, true])

    // The candles are the ones the 5s bars make.
    const fromSeconds = (interval: string): KLineData => {
      const open = FX_GRID.start(interval, cursor - 1)
      const parts = store.all('5s').filter((b) => b.open >= open && b.end <= cursor)
      return asKLine(composeForming(interval, open, parts, FX_GRID) as ReplayBar)
    }
    expect(day.data.at(-1)).toEqual(fromSeconds('1D'))
    expect(hour.data.at(-1)).toEqual(fromSeconds('1h'))
    // Tuesday's session closed whole on the way: it is the stored 1D bar.
    expect(day.data.at(-2)).toEqual(asKLine(store.all('1D')[1]))

    // What was read: 5s from the last whole minute, 1m from the last whole hour. Before, the 5s
    // cache extended from where the last step left it -- a day of 5s bars.
    const seconds = store.calls.filter((c) => c.interval === '5s')
    const minutes = store.calls.filter((c) => c.interval === '1m')
    expect(seconds.length).toBe(1)
    expect(seconds[0].from).toBe(ny(20, 6, 12))
    expect(minutes.length).toBe(1)
    expect(minutes[0].from).toBe(ny(20, 6))
    expect(store.calls.reduce((n, c) => n + (c.interval === '5s' ? c.bars : 0), 0)).toBeLessThan(500)
  })

  test("a pane too far behind reloads at once, not after the other panes' reads", async () => {
    const store = STORE.fresh()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const held: BarSource = {
      fetch: async (symbol, interval, from, to) => {
        await gate
        return store.fetch(symbol, interval, from, to)
      }
    }
    const before = ny(19, 6)
    const hub = new ReplayFeedHub(held, '1m', before)
    hub.setStored('oanda:EURUSD', ['1m', '1h', '1D'])
    const hour = fxPane('hour', '1h', store.all('1h').filter((b) => b.open < before).slice(-20).map(asKLine))
    const minute = fxPane('minute', '1m', store.all('1m').filter((b) => b.open < before).slice(-20).map(asKLine))
    let resets = 0
    ;(minute.pane as unknown as { getChart: () => unknown }).getChart = () => ({ getDataList: () => minute.data, resetData: () => resets++ })
    // Three and a half hours on: 210 minutes is past the append threshold, 3 hours is not.
    hub.cursor = ny(19, 9, 30)
    const pushing = hub.push([hour.pane, minute.pane], before)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(resets).toBe(1)
    release()
    const reports = await pushing
    expect(reports.map((r) => [r.paneId, r.reloaded, r.problem])).toEqual([
      ['hour', false, null],
      ['minute', true, null]
    ])
    // The reloaded pane composed nothing: every read was for the hourly pane.
    expect(store.calls.every((c) => c.from >= ny(19, 5))).toBe(true)
  })

  test('an instrument with nothing stored known composes from the base, as before', async () => {
    const store = STORE.fresh()
    const before = ny(19, 6, 0, 20)
    const hub = new ReplayFeedHub(store, '5s', before)
    const day = fxPane('day', '1D', [asKLine(store.all('1D')[0])])
    const cursor = ny(19, 9, 30, 15)
    hub.cursor = cursor
    const [report] = await hub.push([day.pane], before)
    expect(report.problem).toBeNull()
    const parts = store.all('5s').filter((b) => b.open >= ny(18, 17) && b.end <= cursor)
    expect(day.data.at(-1)).toEqual(asKLine(composeForming('1D', ny(18, 17), parts, FX_GRID) as ReplayBar))
    expect(new Set(store.calls.filter((c) => c.interval !== '1D').map((c) => c.interval))).toEqual(new Set(['5s']))
  })

  test('an instrument the hub was not told about is probed once, at the cursor', async () => {
    const store = STORE.fresh()
    const probes: Array<{ symbol: string; at: number }> = []
    const cursor = ny(19, 9, 30, 15)
    const hub = new ReplayFeedHub(store, '5s', cursor, async (symbol, at) => {
      probes.push({ symbol, at })
      return ['5s', '1m', '1h']
    })
    const day = fxPane('day', '1D', [asKLine(store.all('1D')[0])])
    await hub.push([day.pane], cursor - 5_000)
    hub.cursor = cursor + 5_000
    await hub.push([day.pane], cursor)
    expect(probes).toEqual([{ symbol: 'oanda:EURUSD', at: cursor }])
    expect(store.calls.some((c) => c.interval === '1h')).toBe(true)
  })
})

// THE WINDOW A PANE RELOADS INTO ENDS PAST THE BAR FORMING AT THE CURSOR. A forex day forming
// from Tuesday 17:00 is dated Wednesday 00:00 on the wire -- after the cursor -- so a window
// ending at the cursor left it out: a 1D pane reloaded between 17:00 and midnight drew Tuesday
// as its last candle (prod EURGBP at 2023-10-24 19:00 New York), the day it was in nowhere.
const { setReadClock } = await import('../config')

describe('ReplayDatafeed re-anchors a window at what the cursor lets be answered', () => {
  const DAY = resolutionToPeriod('1D') as Period

  /** `/getbars` under `asof` over the store's bars, as `services/ohlcv.py` answers it: the closed
   * bars dated inside the window and the day forming at the clock rebuilt from the 5s rows that
   * had closed. No tiles and the FX week's schedule. */
  function server(store: AggregatedStore) {
    const asked: Array<{ from: number; to: number }> = []
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/instrument')) {
        const sessions = [{ openDay: 'sun', openTime: '17:00', closeDay: 'fri', closeTime: '17:00' }]
        return Response.json({ vendor: 'oanda', symbol: 'EURUSD', marketHours: { timezone: 'America/New_York', sessions } })
      }
      if (!url.pathname.endsWith('/getbars')) return new Response('not found', { status: 404 })
      const from = Number(url.searchParams.get('from'))
      const to = Number(url.searchParams.get('to'))
      const asof = Number(url.searchParams.get('asof'))
      asked.push({ from, to })
      const answer = store.all('1D').filter((b) => b.end <= asof && b.date >= from && b.date < to)
      const open = FX_GRID.start('1D', asof)
      if (open < asof && asof < FX_GRID.end('1D', open)) {
        const forming = composeForming('1D', open, store.all('5s').filter((b) => b.open >= open && b.end <= asof), FX_GRID)
        if (forming && forming.date >= from && forming.date < to) answer.push(forming)
      }
      const bars = answer.map((b) => ({ date: b.date, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }))
      return Response.json(bars.length === 0 ? { s: 'no_data' } : bars)
    }
    return { asked, fetch: fetch as typeof globalThis.fetch }
  }

  test('a forex day pane reloaded at 19:00 gets the day forming since 17:00, dated tomorrow', async () => {
    const store = STORE.fresh()
    const api = server(store)
    const originalFetch = globalThis.fetch
    globalThis.fetch = api.fetch
    try {
      for (const [cursor, last] of [
        // Two hours into the day dated Wednesday: it has rows, and is the pane's last candle.
        [ny(19, 19), ny(20, 0)],
        // On its open nothing of it exists: Tuesday's day, closed at 17:00, is the last.
        [ny(19, 17), ny(19, 0)],
        // Mid-session the day is dated before the cursor, and was answered before too.
        [ny(20, 11), ny(20, 0)]
      ] as const) {
        setReadClock(cursor)
        const hub = new ReplayFeedHub(store, '5s', cursor)
        const symbol = { ticker: 'EURUSD', exchange: 'oanda', timezone: FX_SCHEDULE.timezone, dayGeometry: FX_SCHEDULE.day } as SymbolInfo
        const now = Date.now()
        const bars = await hub.createFeed().getHistoryKLineData(symbol, DAY, now - 500 * 86_400_000, now)
        expect(bars.at(-1)?.timestamp).toBe(last)
        if (last > cursor) {
          const open = FX_GRID.start('1D', cursor)
          const parts = store.all('5s').filter((b) => b.open >= open && b.end <= cursor)
          expect(bars.at(-1)).toEqual(asKLine(composeForming('1D', open, parts, FX_GRID) as ReplayBar))
        }
        // And never a date past the forming day: the window stops at the next day's.
        expect(Math.max(...api.asked.map((a) => a.to))).toBeLessThanOrEqual(FX_GRID.toWire('1D', FX_GRID.nextStart('1D', cursor)))
        api.asked.length = 0
      }
    } finally {
      globalThis.fetch = originalFetch
      setReadClock(null)
    }
  })
})

// THE BARS A PANE WILL HOLD AT THE NEXT LANDING (`landingRange`), which is what a bar replay warms
// the server over before the press. It must be what the push will really leave -- worked out by
// the same rule -- or the warm-up builds a region the panes then do not read.

describe('ReplayFeedHub.landingRange', () => {
  const M = 60_000
  const range = (data: KLineData[]) => ({ from: data[0].timestamp, to: (data.at(-1)?.timestamp ?? 0) + 1 })

  test('short of the append threshold: the pane keeps its bars, to the bar open at the landing -- what the push leaves', async () => {
    const before = ny(19, 6)
    for (const at of [ny(19, 9, 30), ny(19, 10)]) {
      const store = STORE.fresh()
      const hub = new ReplayFeedHub(store, '1m', before)
      hub.setStored('oanda:EURUSD', ['1m', '1h', '1D'])
      const hour = fxPane('hour', '1h', store.all('1h').filter((b) => b.open < before).slice(-20).map(asKLine))
      const predicted = hub.landingRange(hour.pane, at)
      // Inside the 09:00 bar it is forming; on 10:00 it has closed and none has opened yet.
      expect(predicted).toEqual({ from: hour.data[0].timestamp, to: ny(19, 9) + 1 })
      hub.cursor = at
      const [report] = await hub.push([hour.pane], before)
      expect([report.reloaded, report.problem]).toEqual([false, null])
      expect(range(hour.data)).toEqual(predicted as { from: number; to: number })
    }
  })

  test("past it: the window the pane is reloaded into, from at or before the reload's first bar", async () => {
    const store = STORE.fresh()
    const before = ny(19, 6)
    const hub = new ReplayFeedHub(store, '1m', before)
    hub.setStored('oanda:EURUSD', ['1m', '1h', '1D'])
    const minute = fxPane('minute', '1m', store.all('1m').filter((b) => b.open < before).slice(-20).map(asKLine))
    let resets = 0
    ;(minute.pane as unknown as { getChart: () => unknown }).getChart = () => ({ getDataList: () => minute.data, resetData: () => resets++ })
    // 210 minutes on: past the 100-bar threshold.
    const at = ny(19, 9, 30)
    expect(hub.landingRange(minute.pane, at)).toEqual({ from: at - 500 * M, to: ny(19, 9, 29) + 1 })
    hub.cursor = at
    const [report] = await hub.push([minute.pane], before)
    expect([report.reloaded, resets]).toEqual([true, 1])
    // ...and 99 minutes on is not, by the same rule.
    expect(new ReplayFeedHub(store, '1m', before).landingRange(minute.pane, before + 99 * M)?.from).toBe(minute.data[0].timestamp)
  })

  test('a pane a push would leave alone has none: no bars, or no subscription', () => {
    const hub = new ReplayFeedHub(STORE.fresh(), '1m', ny(19, 6))
    expect(hub.landingRange(fxPane('empty', '1h', []).pane, ny(19, 9))).toBeNull()
    const unsubscribed = fxPane('off', '1h', [bar(ny(19, 5))])
    ;(unsubscribed.pane as unknown as { getDatafeed: () => unknown }).getDatafeed = () => ({ callbackFor: () => undefined })
    expect(hub.landingRange(unsubscribed.pane, ny(19, 9))).toBeNull()
  })

  test("the panes' bar loads are counted while in flight: a reloaded pane's overlays have not asked yet", async () => {
    const realFetch = globalThis.fetch
    const { error: realError, warn: realWarn } = console
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    // What a failed load says on the way out is not this test's business.
    console.error = console.warn = () => {}
    try {
      const hub = new ReplayFeedHub(STORE.fresh(), '1m', ny(19, 9))
      const feed = hub.createFeed()
      const symbol = { ticker: 'EURUSD', exchange: 'oanda', timezone: FX_SCHEDULE.timezone, dayGeometry: FX_SCHEDULE.day } as SymbolInfo
      const period = resolutionToPeriod('1m')
      if (!period) throw new Error('no 1m period')
      const loading = feed.getHistoryKLineData(symbol, period, ny(19, 1), ny(19, 9))
      expect(hub.loadsInFlight).toBe(1)
      // A load that fails still ends.
      expect(await loading).toEqual([])
      expect(hub.loadsInFlight).toBe(0)
    } finally {
      globalThis.fetch = realFetch
      console.error = realError
      console.warn = realWarn
    }
  })
})
