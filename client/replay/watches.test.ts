import { describe, expect, test } from 'bun:test'
import type { NotificationSpec } from '../notifications'
import { installWindow } from '../plugins/testing'
import { priceCondition, PRICE_SOURCE } from '../watch/types'
import type { BarSource, ReplayBar } from './cache'
import { Engine } from './engine'
import { SignalBook, type SignalHit, type SignalSource } from './signals'
import { fromWall, intervalEnd, toWireDate } from './timeframes'

// PRICE WATCHES ON A REPLAY WALL, end to end: a watch created the way the chart's dialog
// creates one, driven by a real session over a synthetic price path.
//
// What these are really pinning is the sentence in watches.ts: the observations come from
// the BASE bars the walk consumes. That has two consequences a unit test of the registry
// could not see -- an armed watch has to make the advance walk at all, and the instant a
// watch fires at is the base bar's close.

// session.ts reaches ../trading/api -> ../auth -> ../config, which read `window` at import.
installWindow()
const { ReplayTradingSession } = await import('./session')
const { ReplayWatches, observeBar } = await import('./watches')

const H = 3_600_000
const SYM = 'oanda:EURUSD'

function ny(text: string): number {
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi), 'America/New_York')
}

const START = ny('2024-03-04 04:00')

/** 1h bars whose bid rises 10 pips an hour from 1.1000, with a 2-pip spread and a 5-pip
 * wick either side. Mid close of the bar opening at `START + n*H` is 1.1001 + n*0.0010. */
class HourlySource implements BarSource {
  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    if (interval !== '1h') return []
    const out: ReplayBar[] = []
    for (let i = 0; i < 12; i++) {
      const open = START + i * H
      if (open < from || open >= to) continue
      const bid = 1.1 + i * 0.001
      out.push({
        open,
        end: intervalEnd('1h', open),
        date: toWireDate('1h', open),
        o: bid + 0.0001,
        h: bid + 0.00055,
        l: bid - 0.00045,
        c: bid + 0.0001,
        v: 10,
        bid: { o: bid, h: bid + 0.0005, l: bid - 0.0005, c: bid },
        ask: { o: bid + 0.0002, h: bid + 0.0007, l: bid - 0.0003, c: bid + 0.0002 }
      })
    }
    return out
  }
}

class NoSignals implements SignalSource {
  async points(): Promise<SignalHit[]> {
    return []
  }
}

interface Harness {
  session: InstanceType<typeof ReplayTradingSession>
  watches: InstanceType<typeof ReplayWatches>
  raised: NotificationSpec[]
  saved: Array<{ watches: unknown[] }>
}

/** The cursor starts one bar in, so a crossing armed before the first step has a bar behind
 * it to be seeded from -- which is the ordinary case (a replay starts inside stored history).
 */
async function make(cursor = START + H): Promise<Harness> {
  const raised: NotificationSpec[] = []
  const saved: Array<{ watches: unknown[] }> = []
  const watches = new ReplayWatches({
    symbol: SYM,
    notify: {
      notify: (spec) => {
        raised.push(spec)
        return { ...spec, id: 'n', at: spec.at ?? 0, level: spec.level ?? 'info', seen: false }
      }
    }
  })
  const session = new ReplayTradingSession({
    id: 's1',
    name: 'Replay',
    createdAt: 0,
    vendor: 'oanda',
    symbol: SYM,
    cursor,
    startedAt: START,
    base: '1h',
    advance: { interval: '1h', multiple: 1 },
    pauseOnFill: false,
    storedIntervals: ['1h'],
    engine: new Engine(10_000),
    signals: new SignalBook([], new NoSignals()),
    barSource: new HourlySource(),
    dataEnd: () => START + 12 * H,
    save: async (state) => {
      saved.push(state as unknown as { watches: unknown[] })
    },
    onAdvanced: () => {},
    observer: watches
  })
  session.setIntervalsInUse(['1h'])
  watches.attach(session)
  await watches.load()
  return { session, watches, raised, saved }
}

/** The dialog's create call, verbatim: the `price` source, one leaf, on the `price` field. */
function create(h: Harness, level: number, direction: 'crosses' | 'crosses_above' | 'crosses_below' = 'crosses') {
  return h.watches.store.create({
    source: PRICE_SOURCE,
    target: SYM,
    condition: priceCondition(level, direction),
    name: `EURUSD ${level.toFixed(5)}`,
    repeat: 'once'
  })
}

describe('observeBar', () => {
  test('a base bar becomes a price observation carrying the bar’s range', () => {
    const observation = observeBar({
      open: 0,
      end: H,
      date: 0,
      o: 1.1,
      h: 1.2,
      l: 1.0,
      c: 1.1,
      v: 1,
      bid: { o: 1.1, h: 1.2, l: 1.0, c: 1.1 },
      ask: { o: 1.102, h: 1.202, l: 1.002, c: 1.102 }
    })
    // The mid of bid and ask, exactly as the server's price source computes it -- and the
    // band, which is what lets a level BETWEEN two closes be seen at all.
    expect(observation.price).toEqual({ value: 1.101, low: 1.001, high: 1.201 })
    expect(observation.bid.value).toBe(1.1)
    expect(observation.ask.high).toBe(1.202)
    // No band on the spread: `ask.high − bid.low` would claim a spread that never occurred.
    expect(observation.spread.low).toBeUndefined()
  })

  test('a bar with no bid/ask columns falls back to the traded price', () => {
    const observation = observeBar({ open: 0, end: H, date: 0, o: 1.1, h: 1.2, l: 1.0, c: 1.15, v: 1 })
    expect(observation.price).toEqual({ value: 1.15, low: 1.0, high: 1.2 })
    expect(observation.spread.value).toBe(0)
  })
})

describe('ReplayWatches', () => {
  test('an armed watch makes the advance WALK, and fires on the base bar that reaches it', async () => {
    const h = await make()
    // Nothing rests and nothing is protected: without a watch this advance would seek.
    expect(h.watches.needsBars()).toBe(false)
    // The bar opening at START+H has a mid close of 1.1011 and a mid high of 1.10165; the
    // level sits between the two closes, so only the band can see it.
    await create(h, 1.1015)
    expect(h.watches.needsBars()).toBe(true)

    const result = await h.session.step()
    expect(result?.walked).toBe(true)
    expect(result?.bars.length).toBe(1)

    expect(h.raised.length).toBe(1)
    expect(h.raised[0].title).toBe('EURUSD 1.10150')
    expect(h.raised[0].level).toBe('alert')
    // Tagged as the REPLAY's, not the live watch service's: the row outlives the replay
    // wall in the page-level centre, and its tag has to say which market it is about.
    expect(h.raised[0].source).toBe('replay')
    // The event instant is the BASE BAR'S CLOSE, not the wall clock: a session replaying
    // 2024 dates its firings in 2024, and the cooldown measures on that clock.
    expect((h.raised[0].data as { eventAt: number }).eventAt).toBe(START + 2 * H)
    // ...but the row itself is dated when it was RAISED, so it sorts with everything else.
    expect(h.raised[0].at).toBeUndefined()
    expect(h.raised[0].body).toContain('replay ')

    const watch = h.watches.store.list()[0]
    expect(watch.status).toBe('fired')
    expect(watch.fireCount).toBe(1)
    // A fired one-shot needs no more bars: the advance is free to seek again.
    expect(h.watches.needsBars()).toBe(false)
  })

  test('a level the walk never reaches leaves the watch armed', async () => {
    const h = await make()
    await create(h, 1.5)
    await h.session.step()
    expect(h.raised).toEqual([])
    expect(h.watches.store.list()[0].status).toBe('armed')
  })

  test('a crossing is seeded from the bar the cursor stands on, so it does not fire on arrival', async () => {
    const h = await make()
    // The bar BEHIND the cursor closed at 1.1001, which is what the arm seeds from, and the
    // first stepped bar reaches 1.1016 -- so 1.1005 is a genuine rise through the level.
    await create(h, 1.1005, 'crosses_above')
    await h.session.step()
    expect(h.watches.store.list()[0].status).toBe('fired')

    // Now a level already behind the market: 1.0900 sits below the seed, so a RISE through
    // it never happens again however far the walk goes. Seeding is the whole reason -- with
    // no baseline the first bar would have looked like an arrival.
    const g = await make()
    await create(g, 1.09, 'crosses_above')
    await g.session.step()
    await g.session.step()
    expect(g.raised).toEqual([])
    expect(g.watches.store.list()[0].status).toBe('armed')
  })

  test('the walk is what a watch reads: every base bar in a multi-bar advance is seen', async () => {
    const h = await make()
    // A repeating level watch with no cooldown: one firing per base bar it holds for.
    await h.watches.store.create({
      source: PRICE_SOURCE,
      target: SYM,
      condition: { field: 'price', op: '>=', value: 1.1015 },
      name: 'EURUSD >= 1.10150',
      trigger: 'level',
      repeat: 'always',
      cooldownMs: 0
    })
    const result = await h.session.advanceBy({ interval: '1h', multiple: 4 })
    expect(result?.bars.length).toBe(4)
    // Four bars walked, four events, and the condition holds for every one of them.
    expect(h.raised.length).toBe(4)
    expect(h.raised.map((row) => (row.data as { eventAt: number }).eventAt)).toEqual([
      START + 2 * H,
      START + 3 * H,
      START + 4 * H,
      START + 5 * H
    ])
  })

  test('watches ride in the replay’s state blob, baseline and all', async () => {
    const h = await make()
    await create(h, 1.1015)
    await h.session.step()
    const state = h.saved.at(-1)
    expect(state?.watches.length).toBe(1)

    // A reload: a new set of watches over the stored rows.
    const fresh = await make()
    fresh.watches.restore(state?.watches as never)
    await fresh.watches.load()
    const restored = fresh.watches.store.list()[0]
    expect(restored.status).toBe('fired')
    expect(restored.fireCount).toBe(1)
    expect(restored.name).toBe('EURUSD 1.10150')
  })

  test('another instrument is refused rather than stored as a line that can never fire', async () => {
    const h = await make()
    expect(h.watches.canWatch(SYM)).toBeNull()
    expect(h.watches.canWatch('oanda:GBPUSD')).toContain('EURUSD')
    const created = await h.watches.store.create({
      source: PRICE_SOURCE,
      target: 'oanda:GBPUSD',
      condition: priceCondition(1.3),
      name: 'GBPUSD 1.30000'
    })
    expect(created).toBeNull()
    expect(h.watches.store.list()).toEqual([])
  })

  test('the catalogue advertises only what a replay can actually deliver', async () => {
    const h = await make()
    expect(h.watches.store.catalogue().map((source) => source.id)).toEqual([PRICE_SOURCE])
    expect(h.watches.store.source(PRICE_SOURCE)?.fields.map((f) => f.name)).toEqual(['price', 'bid', 'ask', 'spread'])
  })
})
