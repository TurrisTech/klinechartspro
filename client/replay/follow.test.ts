import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import { priceCondition, PRICE_SOURCE } from '../watch/types'
import type { BarSource, ReplayBar } from './cache'
import { Engine, type EngineState } from './engine'
import { blocked, describeBlockers, type FollowResolution, type FollowTarget, followBase, followOnMount, followRequest, followTarget, movedState, undoBlockers } from './follow'
import type { ReplayState } from './persist'
import type { ObserverStop, ReplayObserver } from './session'
import { CONTINUOUS_DAY, FX_GRID, FX_SCHEDULE, fromWall, gridOf, intervalEnd, toWireDate } from './timeframes'

// A REPLAY FOLLOWING THE CHART to another instrument (follow.ts): the decisions alone, then a real
// session over a synthetic path -- the follow made (the blob it writes, for the new instrument at
// the same cursor, and the rebuild it asks for), the follow refused while something is open on the
// instrument walked (and made once it is closed), and the races a follow has to survive: an
// advance in flight, a newer pick, a pick withdrawn while the blob is being written.

// session.ts reaches ../trading/api -> ../auth -> ../config, which read `window` at import.
installWindow()
const { ReplayTradingSession } = await import('./session')
const { ReplayWatches } = await import('./watches')
const { restore } = await import('./persist')

const H = 3_600_000
const WALKED = 'oanda:EURGBP'
const FOLLOWED = 'oanda:EURUSD'

function ny(text: string): number {
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi), 'America/New_York')
}

const START = ny('2024-03-04 04:00')

/** 1h bars whose bid rises 10 pips an hour from 0.8500, for any instrument. `gate`, when set,
 * holds every read until it resolves -- what keeps an advance in flight for as long as a test
 * needs it to be. */
class HourlySource implements BarSource {
  gate: Promise<void> | null = null
  async fetch(_symbol: string, interval: string, from: number, to: number): Promise<ReplayBar[]> {
    if (this.gate) await this.gate
    if (interval !== '1h') return []
    const out: ReplayBar[] = []
    for (let i = 0; i < 12; i++) {
      const open = START + i * H
      if (open < from || open >= to) continue
      const bid = 0.85 + i * 0.001
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

/** A promise and the hand that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** An observer whose armed count the test sets: what a watch placed mid-follow looks like. */
class CountedObserver implements ReplayObserver {
  armed = 0
  needsBars(): boolean {
    return false
  }
  armedStops(): number {
    return this.armed
  }
  onBar(): ObserverStop[] {
    return []
  }
  seeked(): void {}
  toState() {
    return []
  }
}

/** The target as index.ts builds it, resolving to the FX week with 1h stored unless told
 * otherwise; every resolve is counted. */
function target(symbol = FOLLOWED, answer: () => Promise<FollowResolution> | FollowResolution = () => ({ grid: FX_GRID, stored: ['1h'], inUse: ['1h'] })) {
  const calls: number[] = []
  const t: FollowTarget = {
    symbol,
    vendor: symbol.split(':')[0],
    ticker: symbol.split(':')[1],
    resolve: async (at) => {
      calls.push(at)
      return answer()
    }
  }
  return { target: t, calls }
}

interface Harness {
  session: InstanceType<typeof ReplayTradingSession>
  source: HourlySource
  saved: ReplayState[]
  followed: ReplayState[]
  /** When set, the next save waits on it (and the gate is cleared). */
  holdSave: Promise<void> | null
}

function make(opts: { observer?: ReplayObserver; base?: string; stored?: string[] } = {}): Harness {
  const source = new HourlySource()
  const h: Harness = { session: null as unknown as Harness['session'], source, saved: [], followed: [], holdSave: null }
  h.session = new ReplayTradingSession({
    id: 's1',
    name: 'Replay',
    createdAt: 0,
    vendor: 'oanda',
    grid: FX_GRID,
    symbol: WALKED,
    cursor: START + H,
    startedAt: START,
    base: opts.base ?? '1h',
    advance: { interval: '1h', multiple: 1 },
    pauseOnFill: false,
    storedIntervals: opts.stored ?? ['1h'],
    engine: new Engine(10_000, 'GBP'),
    barSource: source,
    dataEnd: () => START + 12 * H,
    save: async (state) => {
      const hold = h.holdSave
      h.holdSave = null
      if (hold) await hold
      h.saved.push(state)
    },
    onAdvanced: () => {},
    observer: opts.observer,
    onFollowed: (state) => {
      h.followed.push(state)
    }
  })
  h.session.setIntervalsInUse(['1h'])
  return h
}

/** A replay watch layer bound to `h`'s session, as index.ts binds it. */
async function withWatches(): Promise<{ h: Harness; watches: InstanceType<typeof ReplayWatches> }> {
  const watches = new ReplayWatches({ symbol: WALKED, notify: { notify: (spec) => ({ ...spec, id: 'n', at: 0, level: 'info', seen: false }) } })
  const h = make({ observer: watches })
  watches.attach(h.session)
  await watches.load()
  return { h, watches }
}

function stateWith(over: Partial<ReplayState> = {}): ReplayState {
  const engine: EngineState = {
    initialBalance: 10_000,
    currency: 'GBP',
    balance: 10_012,
    clock: START + H,
    nextId: 4,
    quotes: {
      [WALKED]: { symbol: WALKED, time: START + H, bid: 0.851, ask: 0.8512 },
      [FOLLOWED]: { symbol: FOLLOWED, time: START - 30 * H, bid: 1.08, ask: 1.0802 }
    },
    orders: [],
    trades: []
  }
  return { version: 1, vendor: 'oanda', symbol: WALKED, cursor: START + H, startedAt: START, base: '1h', advance: { interval: '1h', multiple: 1 }, pauseOnFill: false, watches: [], engine, ...over }
}

describe('what keeps a replay where it is', () => {
  test('the blockers read as the notice says them', () => {
    expect(blocked({ trades: 0, orders: 0, watches: 0 })).toBe(false)
    expect(blocked({ trades: 0, orders: 0, watches: 1 })).toBe(true)
    expect(describeBlockers({ trades: 1, orders: 0, watches: 0 })).toBe('1 open trade')
    expect(describeBlockers({ trades: 2, orders: 1, watches: 3 })).toBe('2 open trades, 1 pending order and 3 armed price watches')
    expect(undoBlockers({ trades: 1, orders: 0, watches: 0 })).toBe('Close it')
    expect(undoBlockers({ trades: 1, orders: 2, watches: 0 })).toBe('Close or cancel them')
    expect(undoBlockers({ trades: 1, orders: 1, watches: 1 })).toBe('Close, cancel or remove them')
  })

  test('only the ACTIVE pane moved is a request, and the walked instrument withdraws one', () => {
    expect(followRequest('p1', 'p1', FOLLOWED, WALKED)).toBe('follow')
    expect(followRequest('p1', 'p1', WALKED, WALKED)).toBe('back')
    // A wall following its active pane fans the pick out to every other pane, each reported.
    expect(followRequest('p2', 'p1', FOLLOWED, WALKED)).toBeNull()
  })

  test('a wall mounted with no pane on the instrument walked has moved off it; a mixed wall has not', () => {
    // Revert after a follow, or a reload that let the draft go: the wall is back on EURGBP while
    // the blob walks EURUSD -- the active pane moved away from it, as a pick would.
    expect(followOnMount([WALKED], WALKED, FOLLOWED)).toBe(true)
    // A replay wall may mix instruments: one pane on the instrument walked keeps it, even with
    // another pane active.
    expect(followOnMount([WALKED, FOLLOWED], FOLLOWED, WALKED)).toBe(false)
    expect(followOnMount([WALKED], WALKED, WALKED)).toBe(false)
    expect(followOnMount([], null, WALKED)).toBe(false)
  })
})

describe('followBase', () => {
  const inUse = ['5m', '1h']
  const cursor = ny('2024-03-04 10:00')

  test('the base walked now, when the instrument followed stores it and it still fits', () => {
    expect(followBase('1m', inUse, ['5s', '1m', '1h', '1D'], FX_GRID, cursor)).toBe('1m')
  })

  test('a base the instrument followed does not store: the coarsest stored one that fits', () => {
    // A 5s replay of EURGBP followed to XAU_USD, whose store begins at 1m (prod, measured).
    expect(followBase('5s', inUse, ['1m', '1h', '1D'], FX_GRID, cursor)).toBe('1m')
    // 1h is stored and coarser, but does not tile the 5m pane.
    expect(followBase('5s', ['5m'], ['1m', '1h'], FX_GRID, cursor)).toBe('1m')
  })

  test('across schedules a base candle that straddles the cursor gives way to a finer one', () => {
    // A 1D base on the FX week stands at 17:00 New York; a coinbase day runs midnight to midnight
    // UTC, so 17:00 New York is inside one -- walking 1D from there would skip its head.
    const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
    const close = ny('2024-03-04 17:00')
    expect(followBase('1D', ['1D'], ['1m', '1h', '1D'], FX_GRID, close)).toBe('1D')
    expect(followBase('1D', ['1D'], ['1m', '1h', '1D'], crypto, close)).toBe('1h')
    // In the FX weekend no candle is open: nothing straddles it.
    expect(followBase('1D', ['1D'], ['1h', '1D'], FX_GRID, ny('2024-03-09 12:00'))).toBe('1D')
  })

  test('nothing stored that fits: null, and the follow says so', () => {
    expect(followBase('1m', ['5m'], ['1h', '1D'], FX_GRID, cursor)).toBeNull()
  })
})

describe('movedState', () => {
  test('the same session at the same cursor, walking the instrument followed', () => {
    const fired = { wire: { id: 'w1', source: PRICE_SOURCE, target: WALKED, condition: priceCondition(0.86) } }
    const current = stateWith({ watches: [fired as unknown as ReplayState['watches'][number]] })
    const moved = movedState(current, { symbol: FOLLOWED, vendor: 'oanda' }, '1m')
    expect(moved.symbol).toBe(FOLLOWED)
    expect(moved.vendor).toBe('oanda')
    expect(moved.base).toBe('1m')
    expect(moved.cursor).toBe(current.cursor)
    expect(moved.startedAt).toBe(current.startedAt)
    expect(moved.advance).toEqual(current.advance)
    // The account goes along: balance, ids, history.
    expect(moved.engine.balance).toBe(10_012)
    expect(moved.engine.nextId).toBe(4)
    // The instrument left keeps its last quote; the one followed loses a quote from long ago, so
    // the new wall quotes it at the cursor.
    expect(Object.keys(moved.engine.quotes)).toEqual([WALKED])
    // The left instrument's watches (fired, or switched off -- none armed) go with its walk.
    expect(moved.watches).toEqual([])
    // ...and the blob it came from is untouched.
    expect(Object.keys(current.engine.quotes)).toEqual([WALKED, FOLLOWED])
  })
})

describe('followTarget', () => {
  test('resolved as a mount resolves it: market hours, then the store at the cursor, then the panes', async () => {
    const asked: string[] = []
    let panes = ['5s']
    const t = followTarget(
      { symbol: 'oanda:XAU_USD', vendor: 'oanda', ticker: 'XAU_USD' },
      {
        schedule: async (symbol) => {
          asked.push(`schedule ${symbol}`)
          return FX_SCHEDULE
        },
        stored: async (symbol, at) => {
          asked.push(`stored ${symbol} ${at}`)
          return ['1m', '1h', '1D']
        },
        intervalsInUse: () => panes
      }
    )
    // The pane's period is replaced after the pick (no 5s for a metal), before the follow resolves.
    panes = ['1m']
    const answer = await t.resolve(START)
    expect(asked).toEqual(['schedule oanda:XAU_USD', `stored oanda:XAU_USD ${START}`])
    expect(answer).toEqual({ grid: expect.anything(), stored: ['1m', '1h', '1D'], inUse: ['1m'] })
    expect('grid' in answer && answer.grid.schedule).toEqual(FX_SCHEDULE)
  })

  test('no market hours, or nothing stored at the cursor, is a reason not to follow', async () => {
    const none = followTarget({ symbol: 'oanda:XYZ', vendor: 'oanda', ticker: 'XYZ' }, { schedule: async () => null, stored: async () => ['1m'], intervalsInUse: () => [] })
    expect(await none.resolve(START)).toEqual({ problem: 'No market hours for XYZ' })
    const empty = followTarget({ symbol: 'oanda:XYZ', vendor: 'oanda', ticker: 'XYZ' }, { schedule: async () => FX_SCHEDULE, stored: async () => [], intervalsInUse: () => [] })
    expect(await empty.resolve(START)).toEqual({ problem: 'No stored bars for XYZ at the replay’s clock' })
  })
})

describe('a session following the chart', () => {
  test('with nothing open it follows: the blob for the new instrument at the same cursor, then the rebuild', async () => {
    const h = make()
    await h.session.primeQuote()
    // A round trip on the instrument walked: history the account keeps.
    await h.session.placeOrder({ symbol: WALKED, side: 'buy', type: 'market', units: 1000 })
    const traded = h.session.snapshot.trades[0]
    await h.session.closeTrade(traded.id)
    const cursor = h.session.cursor
    const t = target()

    expect(await h.session.follow(t.target)).toBe('followed')
    // Resolved at the cursor, once.
    expect(t.calls).toEqual([cursor])
    expect(h.followed.length).toBe(1)
    const blob = h.followed[0]
    // The blob the rebuild reads is the one persisted last.
    expect(h.saved.at(-1)).toEqual(blob)
    expect(blob.symbol).toBe(FOLLOWED)
    expect(blob.vendor).toBe('oanda')
    expect(blob.cursor).toBe(cursor)
    expect(blob.startedAt).toBe(START)
    expect(blob.base).toBe('1h')
    expect(blob.engine.trades.map((tr) => [tr.id, tr.symbol, tr.closeReason])).toEqual([[traded.id, WALKED, 'manual']])
    expect(Object.keys(blob.engine.quotes)).toEqual([WALKED])
    // Read back the way mountBarReplay reads it.
    expect(restore(JSON.parse(JSON.stringify(blob)))?.symbol).toBe(FOLLOWED)

    // Nothing of this session is used after it: no advance, no order, no save over the blob.
    expect(await h.session.step()).toBeNull()
    await expect(h.session.placeOrder({ symbol: WALKED, side: 'buy', type: 'market', units: 1000 })).rejects.toThrow('moving to EURUSD')
    const saves = h.saved.length
    h.session.setAdvance({ interval: '1h', multiple: 2 })
    await h.session.flushSaves()
    expect(h.saved.length).toBe(saves)
    expect(h.session.followNotice?.moving).toBe(true)
  })

  test('with a trade open it stays, says so, and follows once the trade is closed', async () => {
    const h = make()
    await h.session.primeQuote()
    await h.session.placeOrder({ symbol: WALKED, side: 'buy', type: 'market', units: 1000 })
    const t = target()

    expect(await h.session.follow(t.target)).toBe('blocked')
    expect(h.session.followNotice).toEqual({ symbol: FOLLOWED, ticker: 'EURUSD', problem: null, moving: false })
    expect(h.session.followBlockers).toEqual({ trades: 1, orders: 0, watches: 0 })
    // Nothing was resolved, written or rebuilt, and the replay still walks EURGBP.
    expect(t.calls).toEqual([])
    expect(h.followed).toEqual([])
    expect(h.saved.every((s) => s.symbol === WALKED)).toBe(true)
    const stepped = await h.session.step()
    expect(stepped?.reason).toBe('target')
    expect(h.session.symbol).toBe(WALKED)

    await h.session.closeTrade(h.session.snapshot.trades[0].id)
    expect(h.session.followBlockers).toEqual({ trades: 0, orders: 0, watches: 0 })
    // The notice's Follow: the same target, again.
    expect(await h.session.follow()).toBe('followed')
    expect(h.followed[0].symbol).toBe(FOLLOWED)
    expect(h.followed[0].cursor).toBe(h.session.cursor)
  })

  test('a pending order keeps it too, until it is cancelled', async () => {
    const h = make()
    await h.session.primeQuote()
    await h.session.placeOrder({ symbol: WALKED, side: 'buy', type: 'limit', units: 1000, price: 0.8 })
    expect(await h.session.follow(target().target)).toBe('blocked')
    expect(h.session.followBlockers).toEqual({ trades: 0, orders: 1, watches: 0 })
    await h.session.cancelOrder(h.session.snapshot.orders[0].id)
    expect(await h.session.follow()).toBe('followed')
  })

  test('an armed price watch keeps it, a removed one does not', async () => {
    const { h, watches } = await withWatches()
    await h.session.primeQuote()
    const watch = await watches.store.create({ source: PRICE_SOURCE, target: WALKED, condition: priceCondition(0.9), name: 'EURGBP 0.9' })
    expect(await h.session.follow(target().target)).toBe('blocked')
    expect(h.session.followBlockers).toEqual({ trades: 0, orders: 0, watches: 1 })
    await watches.store.remove(watch?.id ?? '')
    expect(await h.session.follow()).toBe('followed')
    expect(h.followed[0].watches).toEqual([])
  })

  test('an instrument that cannot be walked is refused with its reason, and Follow tries again', async () => {
    const h = make()
    let answer: FollowResolution = { problem: 'No stored bars for EURUSD at the replay’s clock' }
    const t = target(FOLLOWED, () => answer)
    expect(await h.session.follow(t.target)).toBe('refused')
    expect(h.session.followNotice?.problem).toBe('No stored bars for EURUSD at the replay’s clock')
    expect(h.followed).toEqual([])
    // Nothing moved: the replay steps on, on EURGBP.
    expect((await h.session.step())?.reason).toBe('target')

    answer = { grid: FX_GRID, stored: ['1h'], inUse: ['1h'] }
    expect(await h.session.follow()).toBe('followed')
    expect(h.followed[0].symbol).toBe(FOLLOWED)
  })

  test('a base the instrument followed lacks is replaced in the blob', async () => {
    const h = make({ base: '5s', stored: ['5s', '1m', '1h'] })
    h.session.setIntervalsInUse(['1m'])
    const t = target('oanda:XAU_USD', () => ({ grid: FX_GRID, stored: ['1m', '1h', '1D'], inUse: ['1m'] }))
    expect(await h.session.follow(t.target)).toBe('followed')
    expect(h.followed[0].base).toBe('1m')
    // Nothing stored that fits: refused, and said.
    const k = make({ base: '5s', stored: ['5s', '1m'] })
    expect(await k.session.follow(target('oanda:XAU_USD', () => ({ grid: FX_GRID, stored: ['1h'], inUse: ['1m'] })).target)).toBe('refused')
    expect(k.session.followNotice?.problem).toContain('Nothing stored for XAU_USD')
  })

  test('back on the instrument walked, the notice is withdrawn', async () => {
    const h = make()
    await h.session.primeQuote()
    await h.session.placeOrder({ symbol: WALKED, side: 'buy', type: 'market', units: 1000 })
    await h.session.follow(target().target)
    expect(h.session.followNotice).not.toBeNull()
    expect(await h.session.follow(target(WALKED).target)).toBe('withdrawn')
    expect(h.session.followNotice).toBeNull()
  })

  test('an order on an instrument the replay does not walk is refused, even with a quote for it', async () => {
    const h = make()
    await h.session.primeQuote()
    await expect(h.session.placeOrder({ symbol: FOLLOWED, side: 'buy', type: 'market', units: 1000 })).rejects.toThrow('This replay walks EURGBP only')
  })
})

describe('a follow and the things that happen meanwhile', () => {
  test('an advance in flight lands first; what it leaves open is looked at again', async () => {
    const observer = new CountedObserver()
    const h = make({ observer })
    const hold = gate()
    h.source.gate = hold.promise
    const stepping = h.session.step()
    expect(h.session.busy).toBe(true)
    const following = h.session.follow(target().target)
    // Being made: further advances wait for it (Play stops on the null).
    expect(h.session.followNotice?.moving).toBe(true)
    expect(await h.session.step()).toBeNull()
    // A watch armed while the step is still landing (a chart gesture, which an order is not).
    observer.armed = 1
    hold.open()
    expect((await stepping)?.reason).toBe('target')
    expect(await following).toBe('blocked')
    expect(h.session.followBlockers.watches).toBe(1)
    expect(h.followed).toEqual([])

    // Nothing open after the advance: it follows from where the advance landed.
    observer.armed = 0
    const again = gate()
    h.source.gate = again.promise
    const second = h.session.step()
    const followed = h.session.follow()
    again.open()
    const landed = await second
    expect(await followed).toBe('followed')
    expect(h.followed[0].cursor).toBe(landed?.to as number)
  })

  test('a newer pick while one is being made: the newest is the one followed, once', async () => {
    const h = make()
    const slow = gate()
    const first = target(FOLLOWED, async () => {
      await slow.promise
      return { grid: FX_GRID, stored: ['1h'], inUse: ['1h'] }
    })
    const running = h.session.follow(first.target)
    await Promise.resolve()
    const newer = h.session.follow(target('oanda:USDJPY').target)
    expect(newer).toBe(running)
    slow.open()
    expect(await running).toBe('followed')
    expect(h.followed.map((s) => s.symbol)).toEqual(['oanda:USDJPY'])
    // ...and only its blob was written: the one superseded never reached the store.
    expect(h.saved.map((s) => s.symbol)).toEqual(['oanda:USDJPY'])
  })

  test('withdrawn while its blob is being written: the instrument walked is written back', async () => {
    const h = make()
    const hold = gate()
    h.holdSave = hold.promise
    const running = h.session.follow(target().target)
    // Let it reach the save.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    h.session.dismissFollow()
    hold.open()
    expect(await running).toBe('withdrawn')
    expect(h.followed).toEqual([])
    expect(h.saved.map((s) => s.symbol)).toEqual([FOLLOWED, WALKED])
    // ...and it saves again as before.
    h.session.setAdvance({ interval: '1h', multiple: 3 })
    await h.session.flushSaves()
    expect(h.saved.at(-1)?.symbol).toBe(WALKED)
    expect(h.saved.at(-1)?.advance.multiple).toBe(3)
  })
})
