import { afterAll, describe, expect, test } from 'bun:test'
import type { Chart, OverlayCreate } from 'klinecharts'
import type { SymbolInfo } from '../../src'
import { fakePane, installWindow } from '../plugins/testing'
import type { LayerContext } from '../chartlayers/types'

// The Levels layer: when its data goes out of date, what identifies a request, and what it
// draws. `client/config.ts` reads `window` at import, so everything below is loaded after
// the DOM stub, the same way `client/plugins/*.test.ts` does it.
installWindow()
// The wall tests build real controllers, which read the toolbar-era settings once.
const win = globalThis.window as unknown as Record<string, unknown>
win.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const requests: URL[] = []
let nextLevelsBody: unknown = []
/** `X-Levels-Computed-Through` on the next `/levels` answer; `null` = a server that does not
 * send it at all, which is what an older one looks like. */
let watermarkHeader: string | null = null

// Captured before the stub below replaces it, so the afterAll can put back exactly what was
// here rather than an equivalent -- `globalThis.fetch` and `Bun.fetch` are distinct function
// objects even in a pristine process, so restoring the latter would be a swap, not a restore.
const pristineFetch = globalThis.fetch

// A real fetch, answering the two routes this file touches. Nothing in client/ is replaced:
// capabilities.ts parses the document it would parse in a browser, and api.ts builds and
// sends the URL it would send.
//
// Installed at module load, which is what the tests below need -- but bun loads every test
// file into one process, so without the afterAll at the bottom this stub stays live for every
// file evaluated afterwards. It did: client/tiles/parity.test.ts captured it as its "real"
// fetch and sent 13 dev-server requests into the fixture below, failing only in the full
// suite and only after a merge changed the file ordering.
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const url = input instanceof URL ? input : new URL(String(input))
  requests.push(url)
  const isCapabilities = url.pathname.endsWith('/capabilities')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!isCapabilities && watermarkHeader !== null) {
    headers['X-Levels-Computed-Through'] = watermarkHeader
  }
  if (!isCapabilities && answerGate) await answerGate
  const body = isCapabilities ? CAPABILITIES : servedBook ? serverAnswer(servedBook, url) : nextLevelsBody
  return new Response(JSON.stringify(body), {
    status: 200,
    headers
  })
}) as typeof fetch

/** When set, `/levels` answers out of this book the way the server does, instead of with
 * `nextLevelsBody`. */
let servedBook: Level[] | null = null
/** When set, `/levels` answers only once it resolves: a read that stays in flight. */
let answerGate: Promise<void> | null = null

/** wdashboard-server's own filter, restated from the Python rather than from `levelsIn`
 * (ohlcv.py `levels_route`, services/levels.py `LevelsBook.band` + `build_level`): the
 * interval set, spent levels only when asked for, the price band inclusive at both ends, and
 * a lifespan that intersects the window -- not confirmed after `date_to`, and if spent, not
 * last invalidated before `date_from`. */
function serverAnswer(book: Level[], url: URL): Level[] {
  const q = url.searchParams
  const priceMin = Number(q.get('price_min'))
  const priceMax = Number(q.get('price_max'))
  const dateFrom = q.has('date_from') ? Number(q.get('date_from')) : null
  const dateTo = q.has('date_to') ? Number(q.get('date_to')) : null
  const intervals = q.get('intervals')?.split(',') ?? null
  const includeInvalidated = q.get('include_invalidated') === 'true'
  const out: Level[] = []
  for (const level of book) {
    if (intervals && !intervals.includes(level.interval)) continue
    const spent = !level.active
    if (spent && !includeInvalidated) continue
    if (level.price < priceMin || level.price > priceMax) continue
    const lifespanEnd = spent && level.invalidations.length > 0 ? level.invalidations[level.invalidations.length - 1] : null
    if (dateTo !== null && level.effectiveAt > dateTo) continue
    if (dateFrom !== null && lifespanEnd !== null && lifespanEnd < dateFrom) continue
    out.push(level)
  }
  return out
}

const VIEW = { priceMin: 1.05, priceMax: 1.15, from: 1_000_000, to: 2_000_000 }
const BAND = {
  vendor: 'oanda',
  symbol: 'EURUSD',
  priceMin: 1.05,
  priceMax: 1.15,
  dateFrom: 1_000_000,
  dateTo: 2_000_000
}

const CAPABILITIES = {
  version: 'test',
  serverTime: 0,
  intervals: ['1h', '1D', '1W', '1M'],
  features: ['levels.intervals', 'levels.dates', 'levels.computedThrough'],
  limits: {
    maxBarsPerRequest: 5000,
    maxBatchRequests: 12,
    maxBackfillBarCount: 500,
    maxSubscriptionsPerConnection: 32
  },
  levels: [
    { vendor: 'oanda', symbol: 'EURUSD', intervals: ['1M', '1W'], computedThrough: 1_700_000_000_000 },
    { vendor: 'oanda', symbol: 'EURGBP', intervals: ['1M', '1W'], computedThrough: 1_700_000_000_000 }
  ],
  plugins: []
}

const { loadCapabilities } = await import('../capabilities')
await loadCapabilities()

const { levelsLayer } = await import('./layer')
const { fetchLevels, GATHER_MS, levelsComputedThrough, levelsIn, levelsRequestsInFlight } = await import('./api')
const { DEFAULT_LEVELS_CONFIG } = await import('./config')
const { overlaySignature } = await import('../chartlayers/paint')
const { setReadClock } = await import('../config')
const { createLayerController } = await import('../chartlayers/controller')

type Level = Awaited<ReturnType<typeof fetchLevels>>[number]

// ------------------------------------------------------------- the layer's freshness wiring
//
// The rule itself is `freshness.test.ts`; what matters here is that the layer asks it with
// the watermark for the right instrument.

// Without this, the stub above stays live for every test file bun evaluates afterwards.
afterAll(() => {
  globalThis.fetch = pristineFetch
})

describe('staleAt', () => {
  test('the layer declares one', () => {
    expect(typeof levelsLayer.staleAt).toBe('function')
  })

  test('with no answer from the server yet, it is the calendar horizon', () => {
    const at = Date.parse('2026-08-25T09:30:00.000-04:00')
    const ctx = context({ priceMin: 1, priceMax: 1.2, from: 1, to: 2 }, 'NOTASKEDFOR')
    expect(levelsLayer.staleAt?.(at, ctx)).toBe(Date.parse('2026-08-25T17:00:00.000-04:00'))
  })

  test('and on the pane\'s OWN schedule: a coinbase pane looks again at the next UTC midnight', () => {
    // Sunday 22:00 UTC, nothing heard from the server: the calendar horizon. On the forex week
    // that was 17:00 New York -- Monday 21:00 UTC, 21 hours after the coinbase week has closed.
    const at = Date.parse('2026-08-30T22:00:00.000Z')
    const ctx: LayerContext = {
      ...context({ priceMin: 1, priceMax: 2, from: 1, to: 2 }, 'BTCUSD'),
      vendor: 'coinbase',
      symbol: { ticker: 'BTCUSD', shortName: 'BTCUSD', timezone: 'UTC', dayGeometry: { openOffset: 0, closeOffset: 24, everyDayTrades: true } } as SymbolInfo
    }
    expect(levelsLayer.staleAt?.(at, ctx)).toBe(Date.parse('2026-08-31T00:00:00.000Z'))
  })

  test('it reads the watermark of the pane\'s OWN instrument', async () => {
    // Two panes on different symbols whose feeds are at different points must get different
    // horizons; a watermark keyed globally would hand one of them the other's answer.
    nextLevelsBody = []
    watermarkHeader = '1W=0' // declared, nothing consumed
    await fetchLevels({ ...BAND, symbol: 'EURUSD' })
    watermarkHeader = null
    expect(levelsComputedThrough('oanda', 'EURUSD')).toEqual({ '1W': 0 })
    expect(levelsComputedThrough('oanda', 'GBPUSD')).toBeNull()

    // Five minutes after a Friday 17:00 weekly close: EURUSD's feed owes a bar, so that pane
    // looks again shortly; the pane we have heard nothing about waits for the calendar.
    const at = Date.parse('2026-08-21T17:05:00.000-04:00')
    const behind = levelsLayer.staleAt?.(at, context(VIEW, 'EURUSD')) ?? 0
    const unknown = levelsLayer.staleAt?.(at, context(VIEW, 'GBPUSD')) ?? 0
    expect(behind).toBe(at + 150_000) // half of five minutes
    expect(unknown).toBe(Date.parse('2026-08-22T17:00:00.000-04:00'))
    expect(behind).toBeLessThan(unknown)
  })

  test('the instrument key is case-insensitive, as the wire is', async () => {
    nextLevelsBody = []
    watermarkHeader = '1M=123'
    await fetchLevels({ ...BAND, vendor: 'OANDA', symbol: 'eurusd' })
    watermarkHeader = null
    expect(levelsComputedThrough('oanda', 'EURUSD')).toEqual({ '1M': 123 })
  })
})

// ------------------------------------------------------------------- what identifies a read

describe('cacheKey', () => {
  const ctx = context({ priceMin: 1.0, priceMax: 1.2, from: 1000, to: 2000 })

  test('is window-free: panning and rescaling must extend a pane\'s data, not replace it', () => {
    const moved = context({ priceMin: 0.5, priceMax: 3.0, from: 500_000, to: 900_000 })
    expect(levelsLayer.cacheKey(moved, DEFAULT_LEVELS_CONFIG)).toBe(
      levelsLayer.cacheKey(ctx, DEFAULT_LEVELS_CONFIG)
    )
  })

  test('changes with everything that decides WHICH levels exist', () => {
    const base = levelsLayer.cacheKey(ctx, DEFAULT_LEVELS_CONFIG)
    const other = context({ priceMin: 1.0, priceMax: 1.2, from: 1000, to: 2000 }, 'GBPUSD')
    expect(levelsLayer.cacheKey(other, DEFAULT_LEVELS_CONFIG)).not.toBe(base)
    expect(
      levelsLayer.cacheKey(ctx, { ...DEFAULT_LEVELS_CONFIG, showSpent: true })
    ).not.toBe(base)
    expect(
      levelsLayer.cacheKey(ctx, {
        ...DEFAULT_LEVELS_CONFIG,
        intervals: { ...DEFAULT_LEVELS_CONFIG.intervals, '1M': false }
      })
    ).not.toBe(base)
  })

  test('a style-only change keeps the key, so it repaints without a request', () => {
    const base = levelsLayer.cacheKey(ctx, DEFAULT_LEVELS_CONFIG)
    const restyled = {
      ...DEFAULT_LEVELS_CONFIG,
      base: { ...DEFAULT_LEVELS_CONFIG.base, width: 4, colorMode: 'direction' as const }
    }
    expect(levelsLayer.cacheKey(ctx, restyled)).toBe(base)
  })

  test('the interval set is order-insensitive', () => {
    const a = { ...DEFAULT_LEVELS_CONFIG, intervals: { '1M': true, '1W': true, '1D': false } }
    const b = { ...DEFAULT_LEVELS_CONFIG, intervals: { '1W': true, '1D': false, '1M': true } }
    expect(levelsLayer.cacheKey(ctx, a)).toBe(levelsLayer.cacheKey(ctx, b))
  })
})

describe('datumKey', () => {
  test('separates two levels at one price confirmed on different candles', () => {
    expect(levelsLayer.datumKey(level({ price: 1.1, bornAt: 1 }))).not.toBe(
      levelsLayer.datumKey(level({ price: 1.1, bornAt: 2 }))
    )
    // Adjacent fetched windows share their edges and return the same level twice; the merge
    // drops the duplicate by this key, so it must be equal for the same level.
    expect(levelsLayer.datumKey(level({ price: 1.1, bornAt: 1 }))).toBe(
      levelsLayer.datumKey(level({ price: 1.1, bornAt: 1 }))
    )
  })
})

// ----------------------------------------------------------------------------- price alerts
//
// What a click does with what is offered is chartlayers/alerts/alerts.test.ts; the layer's own
// part is what it offers.

describe('alerts', () => {
  test('a live level is offered by its price and timeframe; a spent one is not', () => {
    expect(levelsLayer.alerts?.target(level({ price: 1.1, interval: '1M' }))).toEqual({ price: 1.1, label: '1M level' })
    expect(levelsLayer.alerts?.target(level({ active: false }))).toBeNull()
  })

  test('a new alert takes the pane\'s default zone, 3 pips each side by default, which Make default writes', () => {
    expect(levelsLayer.alerts?.zonePipsSetting).toBe('alerts.zonePips')
    expect(DEFAULT_LEVELS_CONFIG.alerts.zonePips).toBe(3)
  })

  test('every stretch of a level carries the level, which is how a click finds it', () => {
    const tested = level({ invalidations: [1_300_000] })
    const overlays = levelsLayer.toOverlays([tested], context(VIEW), DEFAULT_LEVELS_CONFIG)
    expect(overlays.map((overlay) => overlay.extendData)).toEqual([tested, tested])
  })
})

// ----------------------------------------------------------------------------- what it draws

describe('toOverlays', () => {
  const ctx = context({ priceMin: 1.05, priceMax: 1.15, from: 1_000_000, to: 2_000_000 })

  test('a live level is one ray; each invalidation closes a segment and opens the next', () => {
    const [ray] = levelsLayer.toOverlays([level({ price: 1.1 })], ctx, DEFAULT_LEVELS_CONFIG)
    expect(ray.name).toBe('horizontalRayLine')

    const tested = level({ price: 1.1, invalidations: [1_200_000, 1_400_000] })
    const overlays = levelsLayer.toOverlays([tested], ctx, DEFAULT_LEVELS_CONFIG)
    expect(overlays.map((o) => o.name)).toEqual([
      'horizontalSegment',
      'horizontalSegment',
      'horizontalRayLine'
    ])
    // Each stretch is drawn a step darker than the one before it.
    const colors = overlays.map((o) => (o.styles as { line: { color: string } }).line.color)
    expect(new Set(colors).size).toBe(3)
  })

  test('a level outside the visible price band is not drawn', () => {
    const data = [level({ price: 1.1 }), level({ price: 1.4 }), level({ price: 0.9 })]
    const overlays = levelsLayer.toOverlays(data, ctx, DEFAULT_LEVELS_CONFIG)
    expect(overlays).toHaveLength(1)
    expect(overlays[0].points?.[0].value).toBe(1.1)
  })

  test('a hidden interval is not drawn even when the pane holds it', () => {
    const data = [level({ price: 1.1, interval: '1W' }), level({ price: 1.11, interval: '1M' })]
    const config = {
      ...DEFAULT_LEVELS_CONFIG,
      intervals: { ...DEFAULT_LEVELS_CONFIG.intervals, '1M': false }
    }
    expect(levelsLayer.toOverlays(data, ctx, config)).toHaveLength(1)
  })

  test('every coordinate is clamped near the pane, whatever the level\'s dates', () => {
    // klinecharts extrapolates a timestamp outside the loaded bars at a uniform bar cadence,
    // so a level confirmed in 2003 shown on a 1m chart would be handed an x of about -7e7.
    // Canvas clips such a line but still strokes it, and a dashed spent level walks its dash
    // pattern across every one of those pixels -- enough to lock the tab up.
    const ancient = level({ price: 1.1, effectiveAt: -1e12, invalidations: [-1e12 + 1] })
    const span = ctx.to - ctx.from
    const overlays = levelsLayer.toOverlays([ancient], ctx, DEFAULT_LEVELS_CONFIG)
    expect(overlays.length).toBeGreaterThan(0)
    for (const overlay of overlays) {
      for (const point of overlay.points ?? []) {
        // A margin of DRAW_MARGIN_SPANS on each side, and a ray's direction point one draw
        // window past its end: bounded at fifteen visible spans, not at a billion.
        expect(point.timestamp).toBeGreaterThanOrEqual(ctx.from - 15 * span)
        expect(point.timestamp).toBeLessThanOrEqual(ctx.to + 15 * span)
      }
    }
    // The ancient end lands exactly on the drawing window's edge, not at its own date.
    expect(overlays[0].points?.[0].timestamp).toBe(ctx.from - 4 * span)
  })

  test('THE TICK CASE: a price-axis nudge redraws the identical overlays', () => {
    // A live tick updates the last bar, which re-adjusts the visible range and drifts the
    // autoscaled price axis by a fraction of a pip. `ctx.to` is the last visible BAR's
    // timestamp, so it does not move between candles -- which means nothing `toOverlays`
    // reads has changed except a band edge no level is near. The signature is equal, and the
    // controller therefore leaves the chart alone instead of rebuilding every overlay.
    const data = [level({ price: 1.1 }), level({ price: 1.12, invalidations: [1_500_000] })]
    const before = levelsLayer.toOverlays(data, ctx, DEFAULT_LEVELS_CONFIG)
    const jiggled = context({ ...ctx, priceMin: 1.05 + 3e-6, priceMax: 1.15 - 2e-6 })
    const after = levelsLayer.toOverlays(data, jiggled, DEFAULT_LEVELS_CONFIG)
    expect(overlaySignature(after)).toBe(overlaySignature(before))
  })

  test('...but a level crossing the band edge does change it', () => {
    const data = [level({ price: 1.1 }), level({ price: 1.1501 })]
    const before = levelsLayer.toOverlays(data, ctx, DEFAULT_LEVELS_CONFIG)
    const widened = context({ ...ctx, priceMax: 1.16 })
    expect(overlaySignature(levelsLayer.toOverlays(data, widened, DEFAULT_LEVELS_CONFIG))).not.toBe(
      overlaySignature(before)
    )
  })

  test('...and so does a new candle, which is when a metric can actually have moved', () => {
    const data = [level({ price: 1.1 })]
    const before = levelsLayer.toOverlays(data, ctx, DEFAULT_LEVELS_CONFIG)
    const nextBar = context({ ...ctx, to: ctx.to + 3_600_000 })
    expect(overlaySignature(levelsLayer.toOverlays(data, nextBar, DEFAULT_LEVELS_CONFIG))).not.toBe(
      overlaySignature(before)
    )
  })
})

// ------------------------------------------------------------------------------- the request

describe('fetchLevels', () => {
  test('sends the window as epoch ms and the toggles the server understands', async () => {
    requests.length = 0
    nextLevelsBody = []
    await fetchLevels({
      vendor: 'oanda',
      symbol: 'EURUSD',
      priceMin: 1.05,
      priceMax: 1.15,
      dateFrom: 1_000_000,
      dateTo: 2_000_000,
      intervals: ['1M', '1W'],
      includeInvalidated: true
    })
    const url = requests.at(-1)
    expect(url?.pathname.endsWith('/levels')).toBe(true)
    // All-digit strings only: a 'YYYY-MM-DD' would be localized to New York midnight and
    // silently shift the window away from the visible-range timestamps it came from.
    expect(url?.searchParams.get('date_from')).toBe('1000000')
    expect(url?.searchParams.get('date_to')).toBe('2000000')
    expect(url?.searchParams.get('intervals')).toBe('1M,1W')
    expect(url?.searchParams.get('include_invalidated')).toBe('true')
  })

  test('identical requests in flight at once become ONE read', async () => {
    // A wall of panes on one symbol shares a time axis, so a pan or a replay step lands
    // several byte-identical /levels reads on a browser with six connections to spend.
    requests.length = 0
    nextLevelsBody = [level({ price: 1.1 })]
    const params = {
      vendor: 'oanda',
      symbol: 'EURUSD',
      priceMin: 1.05,
      priceMax: 1.15,
      dateFrom: 1_000_000,
      dateTo: 2_000_000
    }
    const all = await Promise.all([
      fetchLevels(params),
      fetchLevels(params),
      fetchLevels({ ...params }),
      fetchLevels(params)
    ])
    expect(requests).toHaveLength(1)
    for (const result of all) expect(result).toEqual(all[0])
    // Deduplication, not a cache: the entry is gone the moment it settles.
    expect(levelsRequestsInFlight()).toBe(0)
    await fetchLevels(params)
    expect(requests).toHaveLength(2)
  })

  test('a different window asked at another moment is a different request', async () => {
    requests.length = 0
    nextLevelsBody = []
    const params = {
      vendor: 'oanda',
      symbol: 'EURUSD',
      priceMin: 3.05,
      priceMax: 3.15,
      dateFrom: 1_000_000,
      dateTo: 2_000_000
    }
    await fetchLevels(params)
    // Not inside the window just read, so nothing can stand in for it.
    await fetchLevels({ ...params, priceMax: 3.16 })
    expect(requests).toHaveLength(2)
    expect(requests[1].searchParams.get('price_max')).toBe('3.16')
  })

  test('a failure is shared by every caller and clears the entry', async () => {
    requests.length = 0
    const boom = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const params = {
      vendor: 'oanda',
      symbol: 'EURUSD',
      priceMin: 2.0,
      priceMax: 2.1,
      dateFrom: 1,
      dateTo: 2
    }
    const results = await Promise.allSettled([fetchLevels(params), fetchLevels(params)])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(levelsRequestsInFlight()).toBe(0)
    globalThis.fetch = boom
  })
})

// --------------------------------------------------------------- one read per instrument

describe('one read per instrument', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const EURUSD = { vendor: 'oanda', symbol: 'EURUSD' }

  test('asks made together on one instrument are ONE read of their union', async () => {
    // A replay step across a day boundary invalidates every pane of the wall in one task, each
    // with its own band and date window: until 2026-10-29 that was a read per pane.
    requests.length = 0
    servedBook = book()
    const windows = [
      { priceMin: 1.08, priceMax: 1.1, dateFrom: 5_000_000, dateTo: 6_000_000 },
      { priceMin: 1.05, priceMax: 1.12, dateFrom: 3_000_000, dateTo: 7_000_000 },
      { priceMin: 1.0, priceMax: 1.2, dateFrom: 1_000_000, dateTo: 9_000_000 },
      { priceMin: 1.15, priceMax: 1.3, dateFrom: 8_000_000, dateTo: 9_500_000 }
    ]
    const answers = await Promise.all(windows.map((window) => fetchLevels({ ...EURUSD, ...window })))
    servedBook = null
    expect(requests).toHaveLength(1)
    const sent = requests[0].searchParams
    expect([sent.get('price_min'), sent.get('price_max'), sent.get('date_from'), sent.get('date_to')]).toEqual([
      '1',
      '1.3',
      '1000000',
      '9500000'
    ])
    // And every ask is handed exactly what the server answers for its own window -- the same
    // levels, in the same order.
    windows.forEach((window, i) => {
      expect(answers[i]).toEqual(serverAnswer(book(), levelsUrl(window)))
    })
    expect(answers.every((answer) => answer.length > 0)).toBe(true)
  })

  test('with spent levels: a level spent before a window is left out of it, as the server leaves it out', async () => {
    requests.length = 0
    servedBook = book()
    const windows = [
      { priceMin: 1.0, priceMax: 1.3, dateFrom: 6_000_000, dateTo: 7_000_000 },
      { priceMin: 1.0, priceMax: 1.3, dateFrom: 1_000_000, dateTo: 9_000_000 }
    ]
    const answers = await Promise.all(
      windows.map((window) => fetchLevels({ ...EURUSD, ...window, includeInvalidated: true }))
    )
    servedBook = null
    expect(requests).toHaveLength(1)
    const narrow = serverAnswer(book(), levelsUrl(windows[0], true))
    expect(answers[0]).toEqual(narrow)
    // The fixture does exercise it: the wide read holds spent levels the narrow window must not.
    expect(answers[1].filter((level) => !level.active && !narrow.includes(level)).length).toBeGreaterThan(0)
  })

  test('whatever else decides the answer keeps two asks apart', async () => {
    requests.length = 0
    nextLevelsBody = []
    const window = { priceMin: 1.0, priceMax: 1.2, dateFrom: 1, dateTo: 2 }
    await Promise.all([
      fetchLevels({ ...EURUSD, ...window }),
      fetchLevels({ vendor: 'oanda', symbol: 'EURGBP', ...window }),
      fetchLevels({ ...EURUSD, ...window, intervals: ['1W'] }),
      fetchLevels({ ...EURUSD, ...window, includeInvalidated: true })
    ])
    expect(requests).toHaveLength(4)
  })

  test('two read clocks are two reads, and each is sent under the clock it was asked under', async () => {
    requests.length = 0
    nextLevelsBody = []
    const window = { ...EURUSD, priceMin: 1.0, priceMax: 1.2, dateFrom: 1, dateTo: 2 }
    try {
      setReadClock(1_111_000)
      const first = fetchLevels(window)
      // A replay moves the clock while the first ask is still gathering.
      setReadClock(2_222_000)
      const second = fetchLevels(window)
      await Promise.all([first, second])
    } finally {
      setReadClock(null)
    }
    expect(requests.map((url) => url.searchParams.get('asof')).sort()).toEqual(['1111000', '2222000'])
  })

  test('an ask inside a read already in flight waits on it', async () => {
    requests.length = 0
    servedBook = book()
    let answer = (): void => {}
    answerGate = new Promise((resolve) => {
      answer = resolve
    })
    const wide = fetchLevels({ ...EURUSD, priceMin: 1.0, priceMax: 1.3, dateFrom: 0, dateTo: 10_000_000 })
    await sleep(GATHER_MS + 5)
    expect(levelsRequestsInFlight()).toBe(1) // sent, not yet answered
    const inside = { priceMin: 1.1, priceMax: 1.2, dateFrom: 2_000_000, dateTo: 4_000_000 }
    const narrow = fetchLevels({ ...EURUSD, ...inside })
    await sleep(GATHER_MS + 5)
    answerGate = null
    answer()
    const answers = await Promise.all([wide, narrow])
    servedBook = null
    expect(requests).toHaveLength(1)
    expect(answers[1]).toEqual(serverAnswer(book(), levelsUrl(inside)))
  })

  test('an ask inside a window read a moment ago re-reads THAT window, so the browser can revalidate it', async () => {
    // The answer is not kept here: the browser holds it under the union's URL, and asking that
    // URL again is what lets the server's ETag answer 304 instead of reading the book again.
    requests.length = 0
    servedBook = book()
    try {
      setReadClock(3_333_000)
      await Promise.all([
        fetchLevels({ ...EURUSD, priceMin: 1.0, priceMax: 1.1, dateFrom: 1_000_000, dateTo: 5_000_000 }),
        fetchLevels({ ...EURUSD, priceMin: 1.05, priceMax: 1.25, dateFrom: 4_000_000, dateTo: 9_000_000 })
      ])
      const inside = { priceMin: 1.06, priceMax: 1.09, dateFrom: 4_500_000, dateTo: 4_600_000 }
      const answer = await fetchLevels({ ...EURUSD, ...inside })
      expect(requests).toHaveLength(2)
      expect(requests[1].search).toBe(requests[0].search)
      expect(answer).toEqual(serverAnswer(book(), levelsUrl(inside)))
      // Outside every window read: its own.
      await fetchLevels({ ...EURUSD, priceMin: 1.4, priceMax: 1.5, dateFrom: 1, dateTo: 2 })
      expect(requests[2].searchParams.get('price_min')).toBe('1.4')
      // And never across clocks: a window read under another one says nothing about this one.
      setReadClock(4_444_000)
      await fetchLevels({ ...EURUSD, ...inside })
      expect(requests[3].searchParams.get('price_min')).toBe('1.06')
    } finally {
      setReadClock(null)
      servedBook = null
    }
  })

  test('the union read states the watermark for the instrument', async () => {
    nextLevelsBody = []
    watermarkHeader = '1W=777'
    await Promise.all([
      fetchLevels({ vendor: 'oanda', symbol: 'AUDNZD', priceMin: 1, priceMax: 2, dateFrom: 1, dateTo: 2 }),
      fetchLevels({ vendor: 'oanda', symbol: 'AUDNZD', priceMin: 1.5, priceMax: 3, dateFrom: 1, dateTo: 3 })
    ])
    watermarkHeader = null
    expect(levelsComputedThrough('oanda', 'AUDNZD')).toEqual({ '1W': 777 })
  })
})

describe('levelsIn', () => {
  const window = { priceMin: 1.1, priceMax: 1.2, dateFrom: 1_000, dateTo: 2_000 }

  test('the price band is inclusive at both ends', () => {
    const inBand = [level({ price: 1.1, effectiveAt: 1_500 }), level({ price: 1.2, effectiveAt: 1_500 })]
    const outside = [level({ price: 1.0999999, effectiveAt: 1_500 }), level({ price: 1.2000001, effectiveAt: 1_500 })]
    expect(levelsIn([...inBand, ...outside], window)).toEqual(inBand)
  })

  test('a lifespan that intersects the window, not a birth inside it', () => {
    const confirmedEarly = level({ effectiveAt: 10 })
    const confirmedAtTheEnd = level({ effectiveAt: 2_000 })
    const confirmedAfter = level({ effectiveAt: 2_001 })
    const spentInside = level({ active: false, effectiveAt: 10, invalidations: [500, 1_000] })
    const spentBefore = level({ active: false, effectiveAt: 10, invalidations: [500, 999] })
    // An active level has no end, however long ago it was last tested.
    const testedBefore = level({ effectiveAt: 10, invalidations: [20] })
    const all = [confirmedEarly, confirmedAtTheEnd, confirmedAfter, spentInside, spentBefore, testedBefore]
    expect(levelsIn(all, window)).toEqual([confirmedEarly, confirmedAtTheEnd, spentInside, testedBefore])
  })
})

// --------------------------------------------------------------------------------- a wall

describe('a wall of panes', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  let releases: Array<() => void> = []
  afterAll(() => {
    for (const release of releases) release()
    releases = []
  })

  // Six timeframes of one instrument ending at the same instant, each with its own price
  // range -- what the controller turns into six different bands and date windows.
  const SPECS = [
    { step: 300_000, low: 1.095, high: 1.1 },
    { step: 900_000, low: 1.09, high: 1.105 },
    { step: 3_600_000, low: 1.08, high: 1.11 },
    { step: 14_400_000, low: 1.06, high: 1.13 },
    { step: 86_400_000, low: 1.03, high: 1.17 },
    { step: 7 * 86_400_000, low: 0.98, high: 1.25 }
  ]
  const END = 9_000_000_000

  function wallChart(spec: (typeof SPECS)[number]) {
    const bars = Array.from({ length: 60 }, (_, i) => ({
      timestamp: END - (59 - i) * spec.step,
      open: spec.low,
      high: spec.high,
      low: spec.low,
      close: spec.high
    }))
    const state = { overlays: [] as OverlayCreate[] }
    const chart = {
      getIndicators: () => [{ id: 'lv', name: 'LEVELS:levels', visible: true }],
      getDataList: () => bars,
      getVisibleRange: () => ({ from: 0, to: bars.length, realFrom: 0, realTo: bars.length - 1 }),
      getYAxes: () => [{ getRange: () => ({ from: spec.low, to: spec.high }) }],
      createOverlay: (list: OverlayCreate[]) => {
        state.overlays.push(...list)
        return list.map(() => 'id')
      },
      removeOverlay: () => {
        state.overlays = []
      },
      subscribeAction: () => {},
      unsubscribeAction: () => {}
    } as unknown as Chart
    return { chart, state }
  }

  /** The overlays each pane draws, the panes attached to one controller in one task. */
  async function wall(tickers: string[]) {
    const controller = createLayerController(levelsLayer, 'LEVELS:levels')
    const panes = tickers.map((ticker, i) => ({ ticker, ...wallChart(SPECS[i % SPECS.length]) }))
    for (const [i, pane] of panes.entries()) {
      releases.push(controller.attach(fakePane(`p${i}`, pane.chart, pane.ticker), 'lv', DEFAULT_LEVELS_CONFIG))
    }
    await sleep(GATHER_MS + 30)
    return { controller, drawn: () => panes.map((pane) => overlaySignature(pane.state.overlays)) }
  }

  test('a six-pane wall reads once, and a day boundary invalidating every pane reads once more', async () => {
    servedBook = book()
    requests.length = 0
    const { controller, drawn } = await wall(Array(6).fill('EURUSD'))
    expect(requests).toHaveLength(1)
    const opened = drawn()
    controller.invalidate()
    await sleep(GATHER_MS + 30)
    expect(requests).toHaveLength(2)
    expect(drawn()).toEqual(opened)
    servedBook = null
  })

  test('...and every pane draws exactly what it drew when it read alone', async () => {
    servedBook = book()
    const together = (await wall(Array(6).fill('EURUSD'))).drawn()
    // Each pane on its own, under a read clock of its own so that nothing read for the wall
    // can stand in for its own window.
    const alone: string[] = []
    try {
      for (const [i, spec] of SPECS.entries()) {
        setReadClock(5_000_000 + i)
        const controller = createLayerController(levelsLayer, 'LEVELS:levels')
        const { chart, state } = wallChart(spec)
        requests.length = 0
        releases.push(controller.attach(fakePane(`alone${i}`, chart, 'EURUSD'), 'lv', DEFAULT_LEVELS_CONFIG))
        await sleep(GATHER_MS + 30)
        expect(requests).toHaveLength(1)
        alone.push(overlaySignature(state.overlays))
      }
    } finally {
      setReadClock(null)
      servedBook = null
    }
    expect(together).toEqual(alone)
    // Not vacuous: the panes draw different sets, and none draws nothing.
    expect(new Set(together).size).toBe(SPECS.length)
  })

  test('two instruments on one wall are two reads', async () => {
    servedBook = book()
    requests.length = 0
    await wall(['EURUSD', 'EURGBP', 'EURUSD', 'EURGBP', 'EURUSD', 'EURGBP'])
    servedBook = null
    expect(requests.map((url) => url.searchParams.get('symbol')).sort()).toEqual(['EURGBP', 'EURUSD'])
  })
})

describe('available', () => {
  test('follows the server\'s advertised coverage, per instrument', () => {
    expect(levelsLayer.available({ ticker: 'EURUSD' } as SymbolInfo, 'oanda')).toBe(true)
    expect(levelsLayer.available({ ticker: 'GBPUSD' } as SymbolInfo, 'oanda')).toBe(false)
  })
})

// ------------------------------------------------------------------------------------ helpers

function context(
  window: { priceMin: number; priceMax: number; from: number; to: number },
  ticker = 'EURUSD'
): LayerContext {
  return {
    ...window,
    chart: null as unknown as Chart,
    // The forex schedule, as client/symbols.ts resolves it for an OANDA pair: the layer's
    // horizons are worked out on it (freshness.ts).
    symbol: { ticker, shortName: ticker, timezone: 'America/New_York', dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false } } as SymbolInfo,
    vendor: 'oanda'
  }
}

/** A deterministic book across 1.0-1.3 and epoch ms 0-10,000,000 (a seeded LCG, so every
 * call is the same book): actives, tested actives and spent levels, on both intervals. */
function book(): Level[] {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  return Array.from({ length: 400 }, (_, i) => {
    const effectiveAt = Math.floor(next() * 9_000_000)
    const tests = Math.floor(next() * 14)
    const invalidations = Array.from({ length: tests }, (_, k) => effectiveAt + (k + 1) * Math.floor(next() * 100_000 + 1))
    return level({
      interval: i % 3 === 0 ? '1M' : '1W',
      price: Math.round((1 + next() * 0.3) * 1e5) / 1e5,
      bornAt: effectiveAt - 1,
      effectiveAt,
      invalidations,
      active: tests < 10
    })
  })
}

function levelsUrl(window: { priceMin: number; priceMax: number; dateFrom: number; dateTo: number }, includeInvalidated = false): URL {
  const url = new URL('http://test/levels')
  url.searchParams.set('price_min', String(window.priceMin))
  url.searchParams.set('price_max', String(window.priceMax))
  url.searchParams.set('date_from', String(window.dateFrom))
  url.searchParams.set('date_to', String(window.dateTo))
  if (includeInvalidated) url.searchParams.set('include_invalidated', 'true')
  return url
}

function level(over: Partial<Level> = {}): Level {
  return {
    interval: '1W',
    price: 1.1,
    direction: 'support',
    bornAt: 1_100_000,
    effectiveAt: 1_150_000,
    invalidations: [],
    active: true,
    color: '#089981',
    ...over
  }
}
