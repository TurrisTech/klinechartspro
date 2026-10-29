import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { ReplayAlertBook, SearchProgress } from './alerts'
import type { BarSource, ReplayBar } from './cache'
import type { AlertOccurrence } from './clock'
import type { ObserverStop, ReplayObserver } from './session'
import { Engine } from './engine'
import { CONTINUOUS_DAY, type CandleGrid, FX_GRID, fromWall, gridOf, intervalEnd, isMarketOpen, nextIntervalStart, toWireDate } from './timeframes'

// session.ts imports ../trading/api -> ../auth -> ../config, which read `window` at import.
installWindow()
const { ReplayTradingSession, WALK_CHUNK_BARS, WALK_PROGRESS_MS } = await import('./session')

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

/** Alerts that trigger at fixed instants: the search is client/alerts' business (and tested
 * there); the session's is what it does with the answer. */
class FakeAlerts implements ReplayAlertBook {
  asked: Array<{ after: number; until: number }> = []
  constructor(
    protected readonly at: number[],
    private readonly enabled = 1,
    private readonly during?: (progress: SearchProgress) => void
  ) {}
  count(): number {
    return this.enabled
  }
  async next(after: number, until: number, progress: SearchProgress): Promise<AlertOccurrence | null> {
    this.asked.push({ after, until })
    this.during?.(progress)
    if (progress.shouldStop()) return null
    const effective = this.at.find((t) => t > after && t <= until)
    return effective === undefined ? null : { alertId: 'a1', name: 'oversold', symbol: SYM, effective, readings: 'RSI(14) 1h 28.1' }
  }
}

interface Made {
  session: InstanceType<typeof ReplayTradingSession>
  source: SyntheticSource
  saved: unknown[]
  advanced: Array<{ from: number; to: number; reason: string }>
}

function make(
  opts: {
    base?: string
    cursor?: number
    stored?: string[]
    alerts?: ReplayAlertBook
    observer?: ReplayObserver
    warmLanding?: (at: number) => void
    /** Where the synthetic minutes begin, and how many there are. */
    start?: number
    minutes?: number
  } = {}
): Made {
  const start = opts.start ?? ny('2024-03-04 09:00')
  const source = new SyntheticSource(start, opts.minutes ?? 8 * 60)
  const saved: unknown[] = []
  const advanced: Array<{ from: number; to: number; reason: string }> = []
  const session = new ReplayTradingSession({
    id: 's1',
    name: 'Replay',
    createdAt: 0,
    vendor: 'oanda',
    grid: FX_GRID,
    symbol: SYM,
    cursor: opts.cursor ?? start,
    startedAt: start,
    base: opts.base ?? '1h',
    advance: { interval: '1h', multiple: 1 },
    pauseOnFill: false,
    storedIntervals: opts.stored ?? ['1m', '1h', '1D'],
    engine: new Engine(10_000),
    barSource: source,
    dataEnd: () => start + 8 * H,
    save: async (state) => {
      saved.push(state)
    },
    onAdvanced: (r) => {
      advanced.push({ from: r.from, to: r.to, reason: r.reason })
    },
    alerts: opts.alerts,
    observer: opts.observer,
    warmLanding: opts.warmLanding
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

  test('Next alert stops where the alert triggers, and seeks there when nothing is working', async () => {
    const start = ny('2024-03-04 09:00')
    const alerts = new FakeAlerts([start + 3 * H, start + 5 * H])
    const { session, advanced } = make({ alerts })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('alert')
    expect(r?.alert).toMatchObject({ alertId: 'a1', effective: start + 3 * H })
    expect(session.cursor).toBe(start + 3 * H)
    expect(r?.walked).toBe(false)
    // Searched from the cursor to the end of the data.
    expect(alerts.asked[0]).toEqual({ after: start, until: start + 8 * H })
    const again = await session.nextAlert()
    expect(again?.alert?.effective).toBe(start + 5 * H)
    expect(advanced.map((a) => a.reason)).toEqual(['alert', 'alert'])
  })

  test('the bar a press lands on is read while the look-ahead waits, so the press reads nothing', async () => {
    const start = ny('2024-03-04 09:00')
    class Ahead extends FakeAlerts {
      async prefetch(after: number, until: number): Promise<number | null> {
        return this.at.find((t) => t > after && t <= until) ?? null
      }
    }
    // Inside a base bar: the press lands on that bar's close, and that bar is what is read ahead.
    const { session, source } = make({ alerts: new Ahead([start + 3 * H + 20 * M]) })
    session.warmAlerts()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const ahead = source.calls.length
    expect(source.calls.some((c) => c.interval === '1h' && c.from <= start + 3 * H && c.to >= start + 4 * H)).toBe(true)
    const r = await session.nextAlert()
    expect(session.cursor).toBe(start + 4 * H)
    expect(r?.walked).toBe(false)
    expect(source.calls.length).toBe(ahead)
    expect(session.snapshot.quotes[SYM].bid).toBeCloseTo(1.1 + 239 * 0.0001, 9)
  })

  test('the wall is told where a press would land -- the base bar\'s close -- but not while a press is landing there', async () => {
    const start = ny('2024-03-04 09:00')
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    class Gated extends FakeAlerts {
      async prefetch(after: number, until: number): Promise<number | null> {
        await gate
        return this.at.find((t) => t > after && t <= until) ?? null
      }
      async next(after: number, until: number, progress: SearchProgress): Promise<AlertOccurrence | null> {
        // The look-ahead finds its answer while the press is under way.
        release()
        await new Promise((resolve) => setTimeout(resolve, 0))
        return super.next(after, until, progress)
      }
    }
    const told: number[] = []
    const made = make({ alerts: new Gated([start + 2 * H + 20 * M, start + 5 * H + 20 * M]), warmLanding: (at) => told.push(at) })
    made.session.warmAlerts()
    const r = await made.session.nextAlert()
    expect(r?.reason).toBe('alert')
    expect(made.session.cursor).toBe(start + 3 * H)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The first landing was the press's own; the next one is where the following press lands:
    // inside the 14:00 base bar, so on its close.
    expect(told).toEqual([start + 6 * H])
  })

  test("across a weekend, the quote is looked for from Friday's close, not back through it", async () => {
    // Friday 2024-03-01 15:00 to 17:00 New York, then Sunday's open: the market-closed gap between.
    const friday = ny('2024-03-01 15:00')
    const { session, source } = make({ base: '1m', start: friday, minutes: 240 })
    const sunday = ny('2024-03-03 17:00')
    source.calls.length = 0
    const bar = await session.barAt(sunday)
    expect(bar?.open).toBe(ny('2024-03-01 16:59'))
    // One probe back from Friday's 17:00, not widened through the weekend from Sunday's.
    expect(source.calls).toHaveLength(1)
    expect(source.calls[0].from).toBeGreaterThan(ny('2024-03-01 16:00'))
    // Where a Step from the weekend really stops: inside Sunday's session, before its first bar
    // has closed. That session holds nothing yet, so the probe goes to the one before it.
    source.calls.length = 0
    const justAfter = await session.barAt(sunday + 30_000)
    expect(justAfter?.open).toBe(ny('2024-03-01 16:59'))
    expect(source.calls).toHaveLength(2)
    expect(source.calls.every((c) => c.from >= ny('2024-03-01 16:00'))).toBe(true)
  })

  // A stop loss or take profit hit is another Next alert (user, 2026-10-28). The synthetic bid
  // rises a pip a minute from 09:00, its high half a pip above: a long's take profit just under
  // minute 200's high is hit on the 12:20 bar, and a short's stop loss at minute 100's ask high
  // on the 10:40 one.
  const minute = (i: number) => ny('2024-03-04 09:00') + i * M
  const takeProfitAt200 = 1.1 + 200 * 0.0001 + 0.00005 - 0.000001
  async function withTrade(session: InstanceType<typeof ReplayTradingSession>, side: 'buy' | 'sell', protection: { takeProfit?: number; stopLoss?: number }) {
    await session.step()
    await session.placeOrder({ symbol: SYM, side, type: 'market', units: 1000 })
    await session.modifyTrade(session.snapshot.trades[0].id, protection)
  }

  test('a stop loss hit before the alert is where Next alert stops; the alert is still next', async () => {
    const { session } = make({ base: '1m', stored: ['1m', '1h'], alerts: new FakeAlerts([minute(300)]) })
    await withTrade(session, 'sell', { stopLoss: 1.1 + 100 * 0.0001 + 0.00025 })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('fill')
    expect(r?.events.at(-1)).toMatchObject({ kind: 'close', reason: 'stop_loss' })
    expect(session.cursor).toBe(minute(101))
    const again = await session.nextAlert()
    expect(again?.reason).toBe('alert')
    expect(session.cursor).toBe(minute(300))
  })

  test('with no alert, a take profit is where Next alert runs to -- by the hour, then the minute', async () => {
    const run = async (stored: string[]) => {
      const { session } = make({ base: '1m', stored, alerts: new FakeAlerts([]) })
      await withTrade(session, 'buy', { takeProfit: takeProfitAt200 })
      return { r: await session.nextAlert(), cursor: session.cursor }
    }
    const skimmed = await run(['1m', '1h'])
    const walked = await run(['1m'])
    expect(skimmed.r?.reason).toBe('fill')
    expect(skimmed.cursor).toBe(minute(201))
    expect(skimmed.r?.events.at(-1)).toMatchObject({ kind: 'close', reason: 'take_profit', price: takeProfitAt200 })
    // The same answer as the minute-by-minute walk, with the hours nothing could fill on whole.
    expect(walked.cursor).toBe(skimmed.cursor)
    expect(walked.r?.events).toEqual(skimmed.r?.events)
    expect(skimmed.r?.bars.some((b) => b.end - b.open === H)).toBe(true)
    expect(skimmed.r?.bars.length).toBeLessThan(walked.r?.bars.length ?? 0)
  })

  test('a resting limit order filling is where Next alert stops', async () => {
    // A sell limit at minute 150's bid high: the rising bid reaches it on the 11:30 bar.
    const { session } = make({ base: '1m', stored: ['1m', '1h'], alerts: new FakeAlerts([minute(300)]) })
    await session.step()
    const limit = 1.1 + 150 * 0.0001 + 0.00005 - 0.000001
    await session.placeOrder({ symbol: SYM, side: 'sell', type: 'limit', units: 1000, price: limit })
    expect(session.workingStops).toBe(1)
    const r = await session.nextAlert()
    expect(r?.reason).toBe('fill')
    expect(r?.events.at(-1)).toMatchObject({ kind: 'fill', price: limit })
    expect(session.cursor).toBe(minute(151))
  })

  test('a limit the price gaps through over the weekend fills at the open, and the run stops there', async () => {
    // Friday 15:00-17:00 New York around 1.1000, then Sunday's open at 1.0800: a buy limit at
    // 1.0900 is never inside a bar's range, and fills at Sunday's first ask open.
    const friday = ny('2024-03-01 15:00')
    const sunday = ny('2024-03-03 17:00')
    const flat = (open: number, n: number, mid: number): ReplayBar[] =>
      Array.from({ length: n }, (_, i) => {
        const o = open + i * M
        const bid = { o: mid, h: mid + 0.0001, l: mid - 0.0001, c: mid }
        const ask = { o: mid + 0.0002, h: mid + 0.0003, l: mid + 0.0001, c: mid + 0.0002 }
        return { open: o, end: o + M, date: o, o: mid + 0.0001, h: mid + 0.0002, l: mid, c: mid + 0.0001, v: 1, bid, ask }
      })
    const minutes = [...flat(friday, 120, 1.1), ...flat(sunday, 120, 1.08)]
    const hours = (bars: ReplayBar[]): ReplayBar[] => {
      const out: ReplayBar[] = []
      for (let k = 0; k < bars.length; k += 60) {
        const part = bars.slice(k, k + 60)
        const side = (pick: (b: ReplayBar) => { o: number; h: number; l: number; c: number }) => ({ o: pick(part[0]).o, h: Math.max(...part.map((b) => pick(b).h)), l: Math.min(...part.map((b) => pick(b).l)), c: pick(part[part.length - 1]).c })
        out.push({ open: part[0].open, end: part[0].open + H, date: part[0].open, o: part[0].o, h: Math.max(...part.map((b) => b.h)), l: Math.min(...part.map((b) => b.l)), c: part[part.length - 1].c, v: part.length, bid: side((b) => b.bid as never), ask: side((b) => b.ask as never) })
      }
      return out
    }
    const gapped: BarSource = {
      fetch: async (_s, interval, from, to) => (interval === '1h' ? hours(minutes) : minutes).filter((b) => b.open >= from && b.open < to)
    }
    const session = new ReplayTradingSession({
      id: 'g', name: 'g', createdAt: 0, vendor: 'oanda', grid: FX_GRID, symbol: SYM, cursor: friday, startedAt: friday, base: '1m',
      advance: { interval: '1m', multiple: 1 }, pauseOnFill: false, storedIntervals: ['1m', '1h'], engine: new Engine(10_000),
      barSource: gapped, dataEnd: () => sunday + 2 * H, save: async () => {}, onAdvanced: () => {}, alerts: new FakeAlerts([])
    })
    session.setIntervalsInUse(['1h'])
    await session.step()
    await session.placeOrder({ symbol: SYM, side: 'buy', type: 'limit', units: 1000, price: 1.09 })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('fill')
    expect(r?.events.at(-1)).toMatchObject({ kind: 'fill', price: 1.0802 })
    expect(session.cursor).toBe(sunday + M)
  })

  test('with no alert and nothing that ever fills, Next alert is taken back -- the account too', async () => {
    const { session } = make({ base: '1m', stored: ['1m', '1h'], alerts: new FakeAlerts([]) })
    await withTrade(session, 'buy', { takeProfit: 2 })
    const at = session.cursor
    const quote = session.snapshot.quotes[SYM]
    const r = await session.nextAlert()
    expect(r?.reason).toBe('none')
    expect(session.cursor).toBe(at)
    expect(session.snapshot.quotes[SYM]).toEqual(quote)
    expect(session.snapshot.trades).toHaveLength(1)
    expect(session.workingStops).toBe(1)
  })

  test('with nothing ahead, Next alert stays put rather than spend the replay', async () => {
    const start = ny('2024-03-04 09:00')
    const { session, advanced } = make({ alerts: new FakeAlerts([]) })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('none')
    expect(session.cursor).toBe(start)
    // Nothing moved, so the chart is not told the clock did.
    expect(advanced).toEqual([])
  })

  test('with nothing ahead and a price watch that never fires, it stays put too', async () => {
    // It runs for the watch -- and, nothing having fired by the end of the data and nothing
    // being able to fill, takes the run back: the cursor where it was, the watches as they were.
    const start = ny('2024-03-04 09:00')
    const restored: unknown[] = []
    const watching = { ...observer(), armedStops: () => 1, restoreState: (rows: unknown) => restored.push(rows) }
    const { session, advanced } = make({ alerts: new FakeAlerts([]), observer: watching })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('none')
    expect(r?.seeking).toBe('alerts')
    expect(r?.walked).toBe(true)
    expect(watching.seen.length).toBeGreaterThan(0)
    expect(restored).toHaveLength(1)
    expect(session.cursor).toBe(start)
    expect(advanced).toEqual([])
  })

  test('with nothing ahead but a price watch that fires, it runs to the watch', async () => {
    const start = ny('2024-03-04 09:00')
    const watching = { ...observer((_bar, n) => (n === 3 ? [{ label: 'touch' }] : [])), armedStops: () => 1 }
    const { session } = make({ alerts: new FakeAlerts([]), observer: watching })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('watch')
    expect(session.cursor).toBe(start + 3 * H)
  })

  test('an alert finer than the base stops at the close of the base bar it falls in', async () => {
    const start = ny('2024-03-04 09:00')
    // A 1m alert triggering at 10:31 on a 1h base: the walk moves in whole hours.
    const { session } = make({ alerts: new FakeAlerts([start + H + 31 * M]) })
    const r = await session.nextAlert()
    expect(r?.reason).toBe('alert')
    expect(session.cursor).toBe(start + 2 * H)
    // The alert itself is still reported at its own instant.
    expect(r?.alert?.effective).toBe(start + H + 31 * M)
  })

  test('leaving the replay mid-search is a cancel, not a run to the end for a watch', async () => {
    const start = ny('2024-03-04 09:00')
    let session: Made['session'] | null = null
    const alerts = new FakeAlerts([start + 3 * H], 1, () => session?.dispose())
    const made = make({ alerts, observer: { ...observer(), armedStops: () => 1 } })
    session = made.session
    const r = await made.session.nextAlert()
    expect(r?.reason).toBe('cancel')
    expect(made.session.cursor).toBe(start)
    expect(made.advanced).toEqual([])
  })

  test('a Step does not look for alerts: only Next alert stops at one', async () => {
    const start = ny('2024-03-04 09:00')
    const alerts = new FakeAlerts([start + H])
    const { session } = make({ alerts })
    const r = await session.advanceBy({ interval: '1h', multiple: 3 })
    expect(r?.reason).toBe('target')
    expect(session.cursor).toBe(start + 3 * H)
    expect(alerts.asked).toEqual([])
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
/** An observer that sees every bar; `onBar` may return what it raises on one. */
function observer(onBar: (bar: ReplayBar, n: number) => unknown = () => undefined): ReplayObserver & { seen: ReplayBar[] } {
  const seen: ReplayBar[] = []
  return {
    seen,
    needsBars: () => true,
    armedStops: () => 0,
    onBar: (bar) => {
      seen.push(bar)
      const raised = onBar(bar, seen.length)
      return Array.isArray(raised) ? (raised as ObserverStop[]) : []
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
    // Stop pressed while Next alert is still searching ahead.
    const alerts = new FakeAlerts([start + 3 * H], 1, (progress) => {
      session?.cancel()
      progress.onProgress(start + H)
    })
    const made = make({ base: '1m', observer: observer(), alerts })
    session = made.session
    made.session.setIntervalsInUse(['1m'])
    const r = await made.session.nextAlert()
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
        grid: FX_GRID,
        symbol: SYM,
        cursor: start,
        startedAt: start,
        base: '1m',
        advance: { interval: '1D', multiple: 1 },
        pauseOnFill: false,
        storedIntervals: ['1m'],
        engine: new Engine(10_000),
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

/** Hold the thread for `ms`: a bar that costs real time, so a walk lasts long enough to report. */
function spin(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {}
}

interface Seen {
  change: 'walk' | undefined
  busy: boolean
  cursor: number
  advanceFrom: number | null
  walkedTo: number | null
}

/** Every control change the session announces, with what the controls would read at it. */
function watchControls(session: Made['session']): Seen[] {
  const seen: Seen[] = []
  session.onControlChange((change) =>
    seen.push({ change, busy: session.busy, cursor: session.cursor, advanceFrom: session.advanceFrom, walkedTo: session.walkedTo })
  )
  return seen
}

describe('reporting how far a walk has got', () => {
  const start = ny('2024-03-04 09:00')

  test('a walk reports its reach as it goes -- rising, throttled, whole bars -- and clears it at the end', async () => {
    // 240 base bars at 2 ms each: half a second of walk, so several reports are due.
    const made = make({ base: '1m', observer: observer(() => spin(2)) })
    made.session.setIntervalsInUse(['1m'])
    const seen = watchControls(made.session)
    const began = performance.now()
    const r = await made.session.advanceBy({ interval: '1h', multiple: 4 })
    const elapsed = performance.now() - began
    expect(r?.reason).toBe('target')

    const reports = seen.filter((s) => s.change === 'walk').map((s) => s.walkedTo as number)
    // The first before the first page has loaded: the walk has got as far as where it began.
    expect(reports[0]).toBe(start)
    expect(reports.length).toBeGreaterThan(1)
    for (let i = 1; i < reports.length; i++) expect(reports[i]).toBeGreaterThan(reports[i - 1])
    for (const at of reports) {
      // The close of a whole base bar the walk consumed, never past where it landed.
      expect((at - start) % M).toBe(0)
      expect(at).toBeLessThanOrEqual(r?.to as number)
    }
    // At most one per WALK_PROGRESS_MS: the controls redraw on every one.
    expect(reports.length).toBeLessThanOrEqual(Math.floor(elapsed / WALK_PROGRESS_MS) + 1)

    // While it ran, the session's cursor raced ahead -- and the start stayed on offer for the
    // title bar's clock, which is what the chart still shows.
    const during = seen.filter((s) => s.busy)
    expect(during.some((s) => s.cursor > start)).toBe(true)
    for (const s of during) expect(s.advanceFrom).toBe(start)

    // Ended: the last announcements carry no reach, and the idle session none either.
    const after = seen.slice(seen.findLastIndex((s) => s.change === 'walk') + 1)
    expect(after.length).toBeGreaterThan(0)
    for (const s of after) expect(s.walkedTo).toBeNull()
    expect(seen.at(-1)).toMatchObject({ busy: false, advanceFrom: null, walkedTo: null })
    expect(made.session.walkedTo).toBeNull()
    expect(made.session.advanceFrom).toBeNull()
  })

  test('an advance that seeks never reports a reach: it walked nothing', async () => {
    const { session } = make()
    const seen = watchControls(session)
    const r = await session.step()
    expect(r?.walked).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.some((s) => s.change === 'walk')).toBe(false)
    for (const s of seen) expect(s.walkedTo).toBeNull()
    for (const s of seen.filter((x) => x.busy)) expect(s.advanceFrom).toBe(start)
    expect(session.advanceFrom).toBeNull()
  })

  test('a cancelled walk clears its reach, and never reported one past where it stopped', async () => {
    let session: Made['session'] | null = null
    const made = make({
      base: '1m',
      observer: observer((_bar, n) => {
        spin(2)
        if (n === 200) session?.cancel()
      })
    })
    session = made.session
    made.session.setIntervalsInUse(['1m'])
    const seen = watchControls(made.session)
    const r = await made.session.advanceBy({ interval: '1h', multiple: 6 })
    expect(r?.reason).toBe('cancel')
    expect(r?.to).toBe(start + 200 * M)

    const reports = seen.filter((s) => s.change === 'walk').map((s) => s.walkedTo as number)
    expect(reports.length).toBeGreaterThan(1)
    // The date shown is always somewhere a Stop could still leave the cursor.
    for (const at of reports) expect(at).toBeLessThanOrEqual(r?.to as number)
    // While "Stopping…" the walk has not stopped yet, so a reach it reported still stands...
    const asked = seen.find((s) => s.change === undefined && s.busy && s.cursor > start)
    expect(reports).toContain(asked?.walkedTo as number)
    // ...and once it has, it is gone.
    expect(seen.at(-1)).toMatchObject({ busy: false, walkedTo: null, advanceFrom: null })
    expect(made.session.walkedTo).toBeNull()
  })
})

describe('a session on another market\'s schedule', () => {
  /** Hourly BTC bars for every hour of the week -- weekends included -- labelled on the grid the
   * cache asks with. */
  class EveryHour implements BarSource {
    async fetch(_symbol: string, interval: string, from: number, to: number, _columns: unknown, grid: CandleGrid): Promise<ReplayBar[]> {
      const out: ReplayBar[] = []
      for (let open = grid.start(interval, from); open < to; open = grid.nextStart(interval, open)) {
        if (open < from) continue
        const px = 60_000 + (open / H) % 100
        out.push({ open, end: grid.end(interval, open), date: grid.toWire(interval, open), o: px, h: px + 5, l: px - 5, c: px + 1, v: 1 })
      }
      return out
    }
  }

  const UTC = (d: number, h = 0): number => Date.UTC(2024, 2, d, h)
  const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })

  function cryptoSession(cursor: number, observer?: ReplayObserver) {
    const session = new ReplayTradingSession({
      id: 'c1',
      name: 'Replay',
      createdAt: 0,
      vendor: 'coinbase',
      symbol: 'coinbase:BTCUSD',
      grid: crypto,
      cursor,
      startedAt: cursor,
      base: '1h',
      advance: { interval: '1h', multiple: 1 },
      pauseOnFill: false,
      storedIntervals: ['1h', '1D'],
      engine: new Engine(10_000),
      barSource: new EveryHour(),
      dataEnd: () => UTC(20),
      save: async () => {},
      onAdvanced: () => {},
      observer
    })
    session.setIntervalsInUse(['1h'])
    return session
  }

  test('steps from Friday night into Saturday -- the weekend is a market here', async () => {
    const session = cryptoSession(UTC(8, 23))
    await session.step()
    expect(session.cursor).toBe(UTC(9, 0))
    session.setAdvance({ interval: '1D', multiple: 1 })
    await session.step()
    expect(session.cursor).toBe(UTC(10, 0))
  })

  test('a walk through the weekend consumes the weekend\'s bars', async () => {
    const seen: number[] = []
    const watching: ReplayObserver = {
      needsBars: () => true,
      armedStops: () => 0,
      onBar: (bar) => {
        seen.push(bar.open)
        return []
      },
      seeked: () => {},
      toState: () => []
    }
    const session = cryptoSession(UTC(8, 22), watching)
    session.setAdvance({ interval: '1h', multiple: 4 })
    const r = await session.step()
    expect(r?.walked).toBe(true)
    expect(seen).toEqual([UTC(8, 22), UTC(8, 23), UTC(9, 0), UTC(9, 1)])
    expect(session.cursor).toBe(UTC(9, 2))
  })
})

