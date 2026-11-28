import { describe, expect, test } from 'bun:test'
import { BarCache, type BarSource, type ReplayBar } from '../bars/cache'
import { Engine } from '../sim/engine'
import { FX_GRID } from '../time/timeframes'
import { type ObserverStop, ReplayWalker, summaryIntervals, type WalkObserver, type WalkState } from './walk'

// THE WALK on its own: a real engine and real caches over a fake store, with the session reduced
// to what the walk moves (its cursor) and hears (a Stop). What a bar handed over does -- to the
// engine, to the observer, to the cursor -- and where the walk stops; the session's half (walk,
// skim or seek, what a run that found nothing puts back, why it stopped) is session.test.ts's,
// and the skim against a brute-force walk is skim.test.ts's.

const SYM = 'oanda:EURUSD'
const M = 60_000
const H = 60 * M
/** Monday 4 Mar 2024, 09:00 New York: inside the FX week, on an hour. */
const T0 = Date.UTC(2024, 2, 4, 14, 0)

/** Minute `i` from T0: its bid falls a pip over the minute, from 1.1000 less a pip a minute, and
 * its ask is two pips above. Priced in whole pips, so a level half a pip between two is reached
 * on exactly one minute. */
function minute(i: number): ReplayBar {
  const pip = (n: number): number => n / 10_000
  const open = T0 + i * M
  const bid = { o: pip(11_000 - i), h: pip(11_000 - i), l: pip(10_999 - i), c: pip(10_999 - i) }
  const ask = { o: bid.o + 0.0002, h: bid.h + 0.0002, l: bid.l + 0.0002, c: bid.c + 0.0002 }
  return { open, end: open + M, date: open, o: bid.o + 0.0001, h: bid.h + 0.0001, l: bid.l + 0.0001, c: bid.c + 0.0001, v: 1, bid, ask }
}

/** The candle `parts` fold into, as the store's coarser interval holds it. */
function fold(parts: ReplayBar[]): ReplayBar {
  const side = (pick: (b: ReplayBar) => { o: number; h: number; l: number; c: number }) => ({
    o: pick(parts[0]).o,
    h: Math.max(...parts.map((p) => pick(p).h)),
    l: Math.min(...parts.map((p) => pick(p).l)),
    c: pick(parts[parts.length - 1]).c
  })
  const mid = side((b) => b)
  return { open: parts[0].open, end: parts[parts.length - 1].end, date: parts[0].open, ...mid, v: parts.length, bid: side((b) => b.bid ?? b), ask: side((b) => b.ask ?? b) }
}

const MINUTES = Array.from({ length: 120 }, (_, i) => minute(i))
const HOURS = [fold(MINUTES.slice(0, 60)), fold(MINUTES.slice(60))]

/** The store: two hours of minutes and the hours folded from them. Records every read. */
class Store implements BarSource {
  calls: Array<{ interval: string; from: number; to: number }> = []
  private readonly bars: Record<string, ReplayBar[]> = { '1m': MINUTES, '1h': HOURS }
  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    this.calls.push({ interval, from, to })
    return (this.bars[interval] ?? []).filter((b) => b.open >= from && b.open < to)
  }
}

/** An observer that records what it is handed: it raises on the bar `raiseAt` closes, and is
 * quiet over a candle unless `loud` says otherwise. */
function observer(opts: { raiseAt?: number; loud?: (bar: ReplayBar) => boolean; onBar?: (bar: ReplayBar) => void } = {}) {
  const seen: ReplayBar[] = []
  const watching: WalkObserver = {
    needsBars: () => true,
    onBar(bar): ObserverStop[] {
      seen.push(bar)
      opts.onBar?.(bar)
      return bar.end === opts.raiseAt ? [{ label: 'price crosses 1.0950' }] : []
    },
    quietOver: (bar) => !(opts.loud?.(bar) ?? false)
  }
  return { seen, watching }
}

function trail(over: Partial<WalkState> = {}): WalkState {
  return { base: '1m', consumed: [], observed: [], cancelled: false, fillable: false, pauseOn: false, paused: false, events: [], last: null, sliceStart: performance.now(), report: () => {}, ...over }
}

function make(opts: { base?: string; stored?: string[]; observer?: WalkObserver } = {}) {
  const base = opts.base ?? '1m'
  const store = new Store()
  const engine = new Engine(10_000)
  const host = { cursor: T0, cancelling: false }
  const walker = new ReplayWalker({ host, engine, barSource: store, symbol: SYM, grid: FX_GRID, storedIntervals: opts.stored ?? ['1m', '1h'], observer: opts.observer })
  const cache = new BarCache(store, SYM, base, FX_GRID, 'all')
  cache.seek(T0)
  return { store, engine, host, walker, cache, base }
}

const spans = (bars: readonly ReplayBar[]): Array<[number, number]> => bars.map((b) => [b.open, b.end])

describe('summaryIntervals: what a skim reads in place of base bars', () => {
  test('the stored intervals coarser than the base that it tiles, a day at most, coarsest first', () => {
    expect(summaryIntervals(['1m', '5m', '1h', '4h', '1D', '1W', '1M'], '1m')).toEqual(['1D', '4h', '1h', '5m'])
    expect(summaryIntervals(['5s', '1m', '1h', '1D'], '5s')).toEqual(['1D', '1h', '1m'])
  })

  test('none that the base does not tile, and none at all over a daily base', () => {
    expect(summaryIntervals(['1m', '3m', '5m', '15m', '1h'], '3m')).toEqual(['1h', '15m'])
    expect(summaryIntervals(['1h', '1D', '1W'], '1D')).toEqual([])
  })
})

describe('the walk of the base bars', () => {
  test('hands every bar over in order, moving the cursor to each close; with nothing that can fill the engine is not fed', async () => {
    const { seen, watching } = observer()
    const { walker, cache, host, engine } = make({ observer: watching })
    const t = trail()
    await walker.walk(cache, T0 + 10 * M, t)
    expect(spans(t.consumed)).toEqual(spans(MINUTES.slice(0, 10)))
    expect(seen).toEqual(t.consumed)
    expect(t.last).toEqual(MINUTES[9])
    expect(host.cursor).toBe(T0 + 10 * M)
    expect(engine.quotes.size).toBe(0)
    expect([t.events, t.observed, t.cancelled, t.paused]).toEqual([[], [], false, false])
  })

  test('stops on the bar the observer raises something on, with what it raised', async () => {
    const { watching } = observer({ raiseAt: T0 + 4 * M })
    const { walker, cache, host } = make({ observer: watching })
    const t = trail()
    await walker.walk(cache, T0 + 10 * M, t)
    expect(t.consumed.length).toBe(4)
    expect(t.observed).toEqual([{ label: 'price crosses 1.0950' }])
    expect(host.cursor).toBe(T0 + 4 * M)
  })

  test('a Stop is heard between two whole bars -- and before the first, nothing moves', async () => {
    let made: ReturnType<typeof make> | null = null
    const { watching } = observer({
      onBar: (bar) => {
        if (made && bar.end === T0 + 2 * M) made.host.cancelling = true
      }
    })
    made = make({ observer: watching })
    const t = trail()
    await made.walker.walk(made.cache, T0 + 10 * M, t)
    expect([t.consumed.length, t.cancelled, made.host.cursor]).toEqual([2, true, T0 + 2 * M])

    const again = make()
    again.host.cancelling = true
    const u = trail()
    await again.walker.walk(again.cache, T0 + 10 * M, u)
    expect([u.consumed.length, u.cancelled, again.host.cursor]).toEqual([0, true, T0])
  })

  test('a bar whose range reaches a resting order is fed as the finer stored bars inside it, and the walk pauses on the fill', async () => {
    // A buy limit half a pip under minute 10's ask open: the first ask low at or under it is
    // minute 10's, deep inside the first hour.
    const limit = 1.09915
    const run = async (stored: string[]) => {
      const m = make({ base: '1h', stored })
      m.engine.onQuote({ symbol: SYM, time: T0, bid: 1.1, ask: 1.1002 })
      m.engine.submit({ symbol: SYM, side: 'buy', type: 'limit', units: 10_000, price: limit })
      const t = trail({ base: '1h', fillable: true, pauseOn: true })
      await m.walker.walk(m.cache, T0 + 2 * H, t)
      return { m, t }
    }
    const refined = await run(['1m', '1h'])
    // The engine filled on the minute that reached the limit...
    expect(refined.t.events.map((e) => [e.kind, e.time])).toEqual([['fill', T0 + 10 * M]])
    expect(refined.m.store.calls.some((c) => c.interval === '1m')).toBe(true)
    // ...while the walk handed over -- and stopped at the close of -- the BASE bar.
    expect(spans(refined.t.consumed)).toEqual([[T0, T0 + H]])
    expect([refined.t.paused, refined.m.host.cursor]).toEqual([true, T0 + H])

    // With nothing finer stored the hour is the finest bar there is, and fills at its open.
    const coarse = await run(['1h'])
    expect(coarse.t.events.map((e) => [e.kind, e.time])).toEqual([['fill', T0]])
    expect(coarse.m.store.calls.some((c) => c.interval === '1m')).toBe(false)
  })
})

describe('the skim', () => {
  test('a quiet candle goes over whole; one the observer could fire on is descended into, bar by bar', async () => {
    const { seen, watching } = observer({ loud: (bar) => bar.open === T0 + H })
    const { walker, host, store } = make({ observer: watching })
    const t = trail()
    expect(await walker.skim(0, T0, T0 + 2 * H, ['1h'], t)).toBe(false)
    expect(spans(t.consumed)).toEqual([[T0, T0 + H], ...spans(MINUTES.slice(60))])
    expect(seen).toEqual(t.consumed)
    expect(host.cursor).toBe(T0 + 2 * H)
    // The hours once, and the minutes of the loud hour only.
    expect(store.calls).toEqual([
      { interval: '1h', from: T0, to: T0 + 2 * H },
      { interval: '1m', from: T0 + H, to: T0 + 2 * H }
    ])
  })

  test('stops where the observer raises, inside the candle it descended into', async () => {
    const { watching } = observer({ loud: () => true, raiseAt: T0 + H + 6 * M })
    const { walker, host } = make({ observer: watching })
    const t = trail()
    expect(await walker.skim(0, T0, T0 + 2 * H, ['1h'], t)).toBe(true)
    expect(t.consumed.length).toBe(66)
    expect(t.observed).toEqual([{ label: 'price crosses 1.0950' }])
    expect(host.cursor).toBe(T0 + H + 6 * M)
  })
})
