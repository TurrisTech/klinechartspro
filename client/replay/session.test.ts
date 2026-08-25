import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SignalCatalogueEntry } from '../plugins/types'
import type { BarSource, ReplayBar } from './cache'
import { Engine } from './engine'
import { SignalBook, type SignalHit, type SignalSource } from './signals'
import { fromWall, intervalEnd, isMarketOpen, nextIntervalStart, toWireDate } from './timeframes'

// session.ts imports ../trading/api -> ../auth -> ../config, which read `window` at import.
installWindow()
const { ReplayTradingSession } = await import('./session')

const H = 3_600_000
const M = 60_000
const SYM = 'oanda:EURUSD'

function ny(text: string): number {
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi), 'America/New_York')
}

/** A deterministic price path: 1m bars whose bid rises 1 pip a minute from `start`; every
 * coarser interval is aggregated from it, so the two agree exactly. */
class SyntheticSource implements BarSource {
  calls: Array<{ interval: string; from: number; to: number }> = []
  constructor(
    private readonly start: number,
    private readonly minutes: number,
    private readonly px0 = 1.1
  ) {}

  private minuteBars(): ReplayBar[] {
    const out: ReplayBar[] = []
    let open = this.start
    for (let i = 0; i < this.minutes; i++) {
      while (!isMarketOpen(open)) open = nextIntervalStart('1m', open)
      const bid = this.px0 + i * 0.0001
      out.push({
        open,
        end: open + M,
        date: open,
        o: bid + 0.0001,
        h: bid + 0.00015,
        l: bid - 0.00005,
        c: bid + 0.0001,
        v: 1,
        bid: { o: bid, h: bid + 0.00005, l: bid - 0.00015, c: bid },
        ask: { o: bid + 0.0002, h: bid + 0.00025, l: bid + 0.00005, c: bid + 0.0002 }
      })
      open += M
    }
    return out
  }

  private aggregated(interval: string): ReplayBar[] {
    const mins = this.minuteBars()
    const buckets = new Map<number, ReplayBar[]>()
    for (const m of mins) {
      const bucket = fromWall(Math.floor(toWallLocal(m.open) / bucketLen(interval)) * bucketLen(interval))
      const list = buckets.get(bucket) ?? []
      list.push(m)
      buckets.set(bucket, list)
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([open, parts]) => ({
        open,
        end: intervalEnd(interval, open),
        date: toWireDate(interval, open),
        o: parts[0].o,
        h: Math.max(...parts.map((p) => p.h)),
        l: Math.min(...parts.map((p) => p.l)),
        c: parts[parts.length - 1].c,
        v: parts.length,
        bid: { o: parts[0].bid?.o as number, h: Math.max(...parts.map((p) => p.bid?.h as number)), l: Math.min(...parts.map((p) => p.bid?.l as number)), c: parts[parts.length - 1].bid?.c as number },
        ask: { o: parts[0].ask?.o as number, h: Math.max(...parts.map((p) => p.ask?.h as number)), l: Math.min(...parts.map((p) => p.ask?.l as number)), c: parts[parts.length - 1].ask?.c as number }
      }))
  }

  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    this.calls.push({ interval, from, to })
    const bars = interval === '1m' ? this.minuteBars() : this.aggregated(interval)
    return bars.filter((b) => b.open >= from && b.open < to)
  }
}

// The synthetic series stays inside one Monday session, so the wall clock never crosses DST
// and a 1h bucket is a plain floor of the wall clock.
function toWallLocal(ms: number): number {
  return ms + offset(ms)
}
function offset(ms: number): number {
  return fromWall(0) === 0 ? 0 : -(fromWall(Date.UTC(2024, 2, 4, 9)) - Date.UTC(2024, 2, 4, 9))
}
function bucketLen(interval: string): number {
  return interval === '1h' ? H : interval === '4h' ? 4 * H : M
}

const catalogue: SignalCatalogueEntry[] = [{ plugin: 'arev', title: 'AREV', variant: 'arev21', available: true, id: 'long', label: 'Long', side: 'long', description: '', ref: 'arev:arev21:long' }]

class FakeSignals implements SignalSource {
  constructor(private hits: SignalHit[]) {}
  async points(_r: string, _s: string, _res: string, from: number, to: number): Promise<SignalHit[]> {
    return this.hits.filter((h) => h.date >= from && h.date < to)
  }
}

interface Made {
  session: InstanceType<typeof ReplayTradingSession>
  source: SyntheticSource
  saved: unknown[]
  advanced: Array<{ from: number; to: number; reason: string }>
}

function make(opts: { base?: string; cursor?: number; hits?: SignalHit[]; stored?: string[] } = {}): Made {
  const start = ny('2024-03-04 09:00')
  const source = new SyntheticSource(start, 8 * 60)
  const saved: unknown[] = []
  const advanced: Array<{ from: number; to: number; reason: string }> = []
  const signals = new SignalBook(catalogue, new FakeSignals(opts.hits ?? []))
  const session = new ReplayTradingSession({
    id: 's1',
    name: 'Replay',
    createdAt: 0,
    vendor: 'oanda',
    symbol: SYM,
    cursor: opts.cursor ?? start,
    startedAt: start,
    base: opts.base ?? '1h',
    advance: { interval: '1h', multiple: 1 },
    pauseOnFill: false,
    storedIntervals: opts.stored ?? ['1m', '1h', '1D'],
    engine: new Engine(10_000),
    signals,
    barSource: source,
    dataEnd: () => start + 8 * H,
    save: async (state) => {
      saved.push(state)
    },
    onAdvanced: (r) => {
      advanced.push({ from: r.from, to: r.to, reason: r.reason })
    }
  })
  session.setIntervalsInUse(['1h'])
  return { session, source, saved, advanced }
}

describe('ReplayTradingSession', () => {
  test('a step walks one base bar and quotes from its close', async () => {
    const { session, advanced } = make()
    const start = ny('2024-03-04 09:00')
    const r = await session.step()
    expect(r?.reason).toBe('target')
    expect(session.cursor).toBe(start + H)
    expect(r?.bars.map((b) => b.open)).toEqual([start])
    expect(session.snapshot.quotes[SYM].time).toBe(start + H)
    expect(session.snapshot.quotes[SYM].bid).toBeCloseTo(1.1 + 59 * 0.0001, 9)
    expect(advanced).toEqual([{ from: start, to: start + H, reason: 'target' }])
  })

  test('an armed signal before the target stops the advance at its effective instant', async () => {
    const start = ny('2024-03-04 09:00')
    const { session } = make({ hits: [{ date: start + 2 * H, effective: start + 3 * H }] })
    session.signals.arm('arev:arev21:long', '1h')
    const r = await session.advanceBy({ interval: '1h', multiple: 6 })
    expect(r?.reason).toBe('signal')
    expect(r?.signal?.ref).toBe('arev:arev21:long')
    expect(session.cursor).toBe(start + 3 * H)
    expect(r?.bars.length).toBe(3)
    // Next signal from here: none armed ahead -> the end of the data.
    const n = await session.nextSignal()
    expect(n?.reason).toBe('end')
    expect(session.cursor).toBe(start + 8 * H)
  })

  test('a limit inside a coarse candle makes the engine descend to the finer stored bars', async () => {
    const start = ny('2024-03-04 09:00')
    const { session, source } = make()
    await session.step() // quote at 10:00: bid 1.1059 / ask 1.1061
    // A sell limit at 1.1071 (bid): the 10:00-11:00 hour's bid runs 1.1060 -> 1.1119.
    await session.placeOrder({ symbol: SYM, side: 'sell', type: 'limit', units: 1000, price: 1.1071 })
    // A fresh source: count the refinement fetch.
    source.calls.length = 0
    const r = await session.step()
    expect(source.calls.some((c) => c.interval === '1m')).toBe(true)
    expect(r?.events.map((e) => e.kind)).toEqual(['fill'])
    const trade = session.snapshot.trades[0]
    expect(trade.entryPrice).toBeCloseTo(1.1071, 9)
    // Filled on the minute whose bid range reached the limit -- stamped with that 1m bar's
    // open, not the hour's.
    expect(trade.openedAt).toBeGreaterThan(start + H)
    expect(trade.openedAt).toBeLessThan(start + 2 * H)
    expect((trade.openedAt - start) % M).toBe(0)
  })

  test('with nothing working, or nothing intersecting, the walk stays at the base', async () => {
    const { session, source } = make()
    await session.step()
    source.calls.length = 0
    await session.step()
    expect(source.calls.every((c) => c.interval === '1h')).toBe(true)
    // A limit far below the next hour's range: no descent.
    await session.placeOrder({ symbol: SYM, side: 'buy', type: 'limit', units: 1000, price: 1.05 })
    source.calls.length = 0
    await session.step()
    expect(source.calls.every((c) => c.interval === '1h')).toBe(true)
    expect(session.snapshot.orders[0].status).toBe('pending')
  })

  test('pause on fill stops the walk at the filling bar', async () => {
    const start = ny('2024-03-04 09:00')
    const { session } = make()
    session.setPauseOnFill(true)
    await session.step()
    await session.placeOrder({ symbol: SYM, side: 'buy', type: 'stop', units: 1000, price: 1.12 })
    const r = await session.advanceBy({ interval: '1h', multiple: 6 })
    expect(r?.reason).toBe('fill')
    expect(session.cursor).toBeLessThan(start + 7 * H)
    expect(session.snapshot.orders[0].status).toBe('filled')
  })

  test('a refused request surfaces as an error with the engine message and leaves state alone', async () => {
    const { session, saved } = make()
    await session.step()
    await session.flushSaves()
    const before = saved.length
    await expect(session.placeOrder({ symbol: SYM, side: 'buy', type: 'limit', units: 1, price: 2 })).rejects.toThrow('must be below the ask')
    await session.flushSaves()
    expect(saved.length).toBe(before)
  })

  test('setBase validates against the intervals in use and the stored ladder', () => {
    const { session } = make()
    session.setIntervalsInUse(['15m', '1h'])
    expect(session.setBase('1h').ok).toBe(false)
    expect(session.setBase('15m').ok).toBe(false)
    expect(session.setBase('1m')).toEqual({ ok: true })
    expect(session.base).toBe('1m')
  })

  test('state is saved after every change and restores the engine', async () => {
    const { session, saved } = make()
    await session.step()
    await session.placeOrder({ symbol: SYM, side: 'sell', type: 'market', units: 100 })
    await session.flushSaves()
    const last = saved.at(-1) as { cursor: number; engine: { trades: unknown[] } }
    expect(last.cursor).toBe(session.cursor)
    expect(last.engine.trades.length).toBe(1)
  })
})
