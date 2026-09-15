import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { SignalCatalogueEntry } from '../plugins/types'
import type { BarSource, ReplayBar } from './cache'
import type { ReplayObserver } from './session'
import { Engine } from './engine'
import { SignalBook, type SignalHit, type SignalSource } from './signals'
import { fromWall, intervalEnd, isMarketOpen, nextIntervalStart, toWireDate } from './timeframes'

// session.ts imports ../trading/api -> ../auth -> ../config, which read `window` at import.
installWindow()
const { ReplayTradingSession, WALK_CHUNK_BARS } = await import('./session')

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
  return ms + offset()
}
function offset(): number {
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

function make(opts: { base?: string; cursor?: number; hits?: SignalHit[]; stored?: string[]; signals?: SignalSource; observer?: ReplayObserver } = {}): Made {
  const start = ny('2024-03-04 09:00')
  const source = new SyntheticSource(start, 8 * 60)
  const saved: unknown[] = []
  const advanced: Array<{ from: number; to: number; reason: string }> = []
  const signals = new SignalBook(catalogue, opts.signals ?? new FakeSignals(opts.hits ?? []))
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
    },
    observer: opts.observer
  })
  session.setIntervalsInUse(['1h'])
  return { session, source, saved, advanced }
}

describe('ReplayTradingSession', () => {
  test('a step with nothing working SEEKS: no bars walked, the quote still lands', async () => {
    const { session, advanced } = make()
    const start = ny('2024-03-04 09:00')
    const r = await session.step()
    expect(r?.reason).toBe('target')
    expect(session.cursor).toBe(start + H)
    // Nothing rests and nothing is protected, so no bar could have changed the account.
    expect(r?.walked).toBe(false)
    expect(r?.bars).toEqual([])
    // The quote is still the last base bar closing at the cursor -- the ticket prices right.
    expect(session.snapshot.quotes[SYM].time).toBe(start + H)
    expect(session.snapshot.quotes[SYM].bid).toBeCloseTo(1.1 + 59 * 0.0001, 9)
    expect(advanced).toEqual([{ from: start, to: start + H, reason: 'target' }])
  })

  test('a step with something working WALKS every base bar', async () => {
    const { session } = make()
    const start = ny('2024-03-04 09:00')
    await session.step()
    // A limit far below: it rests, so the walk must happen even though it cannot fill here.
    await session.placeOrder({ symbol: SYM, side: 'buy', type: 'limit', units: 1000, price: 1.05 })
    const r = await session.step()
    expect(r?.walked).toBe(true)
    expect(r?.bars.length).toBe(1) // the harness's base is 1h
    expect(r?.bars[0].open).toBe(start + H)
    expect(session.cursor).toBe(start + 2 * H)
    // An open trade with no protection cannot fill either -- back to seeking.
    await session.cancelOrder(session.snapshot.orders[0].id)
    await session.placeOrder({ symbol: SYM, side: 'buy', type: 'market', units: 1000 })
    const r2 = await session.step()
    expect(r2?.walked).toBe(false)
    // ...but give the trade a stop loss and it walks again.
    await session.modifyTrade(session.snapshot.trades[0].id, { stopLoss: 1.05 })
    const r3 = await session.step()
    expect(r3?.walked).toBe(true)
  })

  test('an armed signal before the target stops the advance at its effective instant', async () => {
    const start = ny('2024-03-04 09:00')
    const { session } = make({ hits: [{ date: start + 2 * H, effective: start + 3 * H }] })
    session.signals.arm('arev:arev21:long', '1h')
    const r = await session.advanceBy({ interval: '1h', multiple: 6 })
    expect(r?.reason).toBe('signal')
    expect(r?.signal?.ref).toBe('arev:arev21:long')
    expect(session.cursor).toBe(start + 3 * H)
    expect(r?.walked).toBe(false)
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

/** An observer that forces the walk and can act on each bar -- the deterministic stand-in for
 * a click that lands mid-walk. */
function observer(onBar: (bar: ReplayBar, n: number) => void = () => {}): ReplayObserver & { seen: ReplayBar[] } {
  const seen: ReplayBar[] = []
  return {
    seen,
    needsBars: () => true,
    armedStops: () => 0,
    onBar: (bar) => {
      seen.push(bar)
      onBar(bar, seen.length)
      return []
    },
    seeked: () => {},
    toState: () => []
  }
}

/** 1m bars with a flat price over any range: enough bars to cross several walk chunks. */
class EndlessMinutes implements BarSource {
  calls: Array<{ from: number; to: number }> = []
  onFetch: () => void = () => {}
  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    this.calls.push({ from, to })
    this.onFetch()
    if (interval !== '1m') return []
    const out: ReplayBar[] = []
    for (let open = Math.ceil(from / M) * M; open < to; open += M) {
      if (!isMarketOpen(open)) continue
      const q = { o: 1.1, h: 1.1001, l: 1.0999, c: 1.1 }
      out.push({ open, end: open + M, date: open, ...q, v: 1, bid: q, ask: { o: 1.1002, h: 1.1003, l: 1.1001, c: 1.1002 } })
    }
    return out
  }
}

describe('cancelling an advance', () => {
  const start = ny('2024-03-04 09:00')

  test('stops before the next base bar, with the cursor on the last whole bar walked', async () => {
    let session: Made['session'] | null = null
    const watching = observer((_bar, n) => {
      if (n === 3) session?.cancel()
    })
    const made = make({ base: '1m', observer: watching })
    session = made.session
    made.session.setIntervalsInUse(['1m'])
    const r = await made.session.advanceBy({ interval: '1h', multiple: 2 })
    expect(r?.reason).toBe('cancel')
    // The bar that asked finished -- engine and observer both saw it whole -- and nothing after.
    expect(r?.bars.length).toBe(3)
    expect(watching.seen.length).toBe(3)
    expect(made.session.cursor).toBe(start + 3 * M)
    expect(r?.to).toBe(start + 3 * M)
    // The chart is told, so the panes move to where the walk actually got to.
    expect(made.advanced).toEqual([{ from: start, to: start + 3 * M, reason: 'cancel' }])
    expect(made.session.cancelling).toBe(false)
    expect(made.session.busy).toBe(false)

    // The request does not outlive the advance it stopped: the next one runs its full course.
    const next = await made.session.advanceBy({ interval: '1m', multiple: 5 })
    expect(next?.reason).toBe('target')
    expect(made.session.cursor).toBe(start + 8 * M)
  })

  test('asked while the advance is still planning, it stops before moving at all', async () => {
    let session: Made['session'] | null = null
    const slowSignals: SignalSource = {
      async points() {
        session?.cancel()
        return []
      }
    }
    const made = make({ base: '1m', observer: observer(), signals: slowSignals })
    session = made.session
    made.session.setIntervalsInUse(['1m'])
    made.session.signals.arm('arev:arev21:long', '1h')
    const r = await made.session.advanceBy({ interval: '1h', multiple: 1 })
    expect(r?.reason).toBe('cancel')
    expect(r?.bars).toEqual([])
    expect(made.session.cursor).toBe(start)
    // Nothing moved, so the chart is not told the clock did (every plugin would refetch).
    expect(made.advanced).toEqual([])
    expect(made.session.lastStop?.reason).toBe('cancel')
  })

  test('idle, it does nothing', async () => {
    const { session } = make()
    session.cancel()
    expect(session.cancelling).toBe(false)
    expect((await session.step())?.reason).toBe('target')
  })

  test('announces itself to the controls, once', async () => {
    let session: Made['session'] | null = null
    let changes = 0
    const made = make({
      base: '1m',
      observer: observer((_bar, n) => {
        if (n !== 1) return
        const before = changes
        session?.cancel()
        session?.cancel()
        expect(session?.cancelling).toBe(true)
        expect(changes).toBe(before + 1)
      })
    })
    session = made.session
    made.session.setIntervalsInUse(['1m'])
    made.session.onControlChange(() => changes++)
    expect((await made.session.advanceBy({ interval: '1h', multiple: 1 }))?.reason).toBe('cancel')
  })

  test('a click can land mid-walk: the walk hands the event loop back', async () => {
    // Every bar costs a millisecond of synchronous work, so the whole walk is ~120 ms, and
    // every await in it resolves as a microtask. A task queued now -- a stand-in for the Stop
    // click, queued the way the browser queues one, behind whatever is running -- can only
    // run mid-walk if the walk yields. (Not a timer: a hidden tab throttles those, which is
    // why the walk does not yield through one either.)
    const made = make({
      base: '1m',
      observer: observer(() => {
        const until = performance.now() + 1
        while (performance.now() < until) {}
      })
    })
    made.session.setIntervalsInUse(['1m'])
    const running = made.session.advanceBy({ interval: '1h', multiple: 2 })
    const click = new MessageChannel()
    click.port1.onmessage = () => {
      click.port1.close()
      made.session.cancel()
    }
    click.port2.postMessage(null)
    const r = await running
    expect(r?.reason).toBe('cancel')
    expect(r?.bars.length).toBeGreaterThan(0)
    expect(r?.bars.length).toBeLessThan(120)
  })

  test('a long walk fetches a page at a time, and a cancel during a fetch stops before the next', async () => {
    const make2 = (source: EndlessMinutes, watching: ReplayObserver) =>
      new ReplayTradingSession({
        id: 's2',
        name: 'Replay',
        createdAt: 0,
        vendor: 'oanda',
        symbol: SYM,
        cursor: start,
        startedAt: start,
        base: '1m',
        advance: { interval: '1D', multiple: 1 },
        pauseOnFill: false,
        storedIntervals: ['1m'],
        engine: new Engine(10_000),
        signals: new SignalBook([], new FakeSignals([])),
        barSource: source,
        dataEnd: () => start + 30 * 24 * H,
        save: async () => {},
        onAdvanced: () => {},
        observer: watching
      })

    // Uncancelled, ten market days at 1m (~14,400 bars) arrive in several page-sized reads.
    const whole = new EndlessMinutes()
    const full = make2(whole, observer())
    full.setIntervalsInUse(['1m'])
    const r = await full.advanceBy({ interval: '1D', multiple: 10 })
    expect(r?.reason).toBe('target')
    expect(whole.calls.length).toBeGreaterThan(2)
    for (const call of whole.calls) expect(call.to - call.from).toBeLessThanOrEqual(WALK_CHUNK_BARS * M)

    // A cancel asked while the first page downloads: that page lands, no bar of it is walked,
    // and the next page is never asked for.
    const paged = new EndlessMinutes()
    const stopped = make2(paged, observer())
    stopped.setIntervalsInUse(['1m'])
    paged.onFetch = () => stopped.cancel()
    const c = await stopped.advanceBy({ interval: '1D', multiple: 10 })
    expect(c?.reason).toBe('cancel')
    expect(c?.bars).toEqual([])
    expect(paged.calls.length).toBe(1)
    expect(stopped.cursor).toBe(start)
  })
})
