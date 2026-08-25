import { describe, expect, test } from 'bun:test'
import type { Chart } from 'klinecharts'
import type { SymbolInfo } from '../../src'
import { installWindow } from '../plugins/testing'
import type { LayerContext } from '../chartlayers/types'

// The Levels layer: when its data goes out of date, what identifies a request, and what it
// draws. `client/config.ts` reads `window` at import, so everything below is loaded after
// the DOM stub, the same way `client/plugins/*.test.ts` does it.
installWindow()

const requests: URL[] = []
let nextLevelsBody: unknown = []

// A real fetch, answering the two routes this file touches. Nothing in client/ is replaced:
// capabilities.ts parses the document it would parse in a browser, and api.ts builds and
// sends the URL it would send.
globalThis.fetch = (async (input: URL | RequestInfo) => {
  const url = input instanceof URL ? input : new URL(String(input))
  requests.push(url)
  const body = url.pathname.endsWith('/capabilities') ? CAPABILITIES : nextLevelsBody
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}) as typeof fetch

const CAPABILITIES = {
  version: 'test',
  serverTime: 0,
  intervals: ['1h', '1D', '1W', '1M'],
  features: ['levels.intervals', 'levels.dates'],
  limits: {
    maxBarsPerRequest: 5000,
    maxBatchRequests: 12,
    maxBackfillBarCount: 500,
    maxSubscriptionsPerConnection: 32
  },
  levels: [
    { vendor: 'oanda', symbol: 'EURUSD', intervals: ['1M', '1W'], computedThrough: 1_700_000_000_000 }
  ],
  plugins: []
}

const { loadCapabilities } = await import('../capabilities')
await loadCapabilities()

const { levelsLayer, levelsStaleAt } = await import('./layer')
const { fetchLevels, levelsRequestsInFlight } = await import('./api')
const { DEFAULT_LEVELS_CONFIG } = await import('./config')
const { overlaySignature } = await import('../chartlayers/paint')

type Level = Awaited<ReturnType<typeof fetchLevels>>[number]

// --------------------------------------------------------------------- when it goes stale

/** Epoch ms of a wall-clock reading in New York. Deliberately spelled out rather than
 * imported, so the expectations below do not lean on the code under test. */
function ny(text: string, offsetHours: number): number {
  return Date.parse(`${text.replace(' ', 'T')}:00.000${offsetHours < 0 ? '-' : '+'}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`)
}
const EDT = -4
const EST = -5

describe('levelsStaleAt -- a level book only changes at 17:00', () => {
  test('mid-session, the horizon is this evening', () => {
    // Levels are computed on 1W and 1M; both close at 17:00 on a market day, so nothing the
    // server holds can change between 09:30 and 17:00 however many 1m candles arrive.
    expect(levelsStaleAt(ny('2026-08-25 09:30', EDT))).toBe(ny('2026-08-25 17:00', EDT))
    expect(levelsStaleAt(ny('2026-08-25 16:59', EDT))).toBe(ny('2026-08-25 17:00', EDT))
  })

  test('after 17:00, the horizon is tomorrow evening', () => {
    expect(levelsStaleAt(ny('2026-08-25 17:00', EDT))).toBe(ny('2026-08-26 17:00', EDT))
    expect(levelsStaleAt(ny('2026-08-25 20:00', EDT))).toBe(ny('2026-08-26 17:00', EDT))
  })

  test('it is always in the future -- a horizon in the past would refetch every redraw', () => {
    for (const hour of [0, 1, 9, 16, 17, 18, 23]) {
      const at = ny(`2026-08-25 ${String(hour).padStart(2, '0')}:00`, EDT)
      expect(levelsStaleAt(at)).toBeGreaterThan(at)
      expect(levelsStaleAt(at) - at).toBeLessThanOrEqual(24 * 3_600_000)
    }
  })

  test('it covers the FRIDAY 17:00 weekly close, not just the daily opens', () => {
    // The distinction matters: a weekly candle closes Friday 17:00 and no daily candle opens
    // then, so a horizon built out of daily OPENS would hold last week's book until Sunday.
    const fridayMorning = ny('2026-08-21 09:00', EDT)
    expect(levelsStaleAt(fridayMorning)).toBe(ny('2026-08-21 17:00', EDT))
  })

  test('it is a wall-clock 17:00 across a DST change, not a fixed number of hours', () => {
    // 2026-03-08 is the US spring-forward: 02:00 EST becomes 03:00 EDT, so Saturday 18:00 to
    // the next 17:00 is 23 hours on the wall and 22 in absolute time. Adding a fixed number
    // of hours would put the horizon an hour late -- past the boundary it exists to catch.
    const saturday = ny('2026-03-07 18:00', EST)
    expect(levelsStaleAt(saturday)).toBe(ny('2026-03-08 17:00', EDT))
    expect(levelsStaleAt(saturday) - saturday).toBe(22 * 3_600_000)
    // ...and the fall-back the other way: 23 wall-clock hours, 24 real ones.
    const autumn = ny('2026-10-31 18:00', EDT)
    expect(levelsStaleAt(autumn)).toBe(ny('2026-11-01 17:00', EST))
    expect(levelsStaleAt(autumn) - autumn).toBe(24 * 3_600_000)
  })

  test('the layer wires it up', () => {
    expect(levelsLayer.staleAt).toBe(levelsStaleAt)
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

  test('a different window is a different request', async () => {
    requests.length = 0
    nextLevelsBody = []
    const params = {
      vendor: 'oanda',
      symbol: 'EURUSD',
      priceMin: 1.05,
      priceMax: 1.15,
      dateFrom: 1_000_000,
      dateTo: 2_000_000
    }
    await Promise.all([fetchLevels(params), fetchLevels({ ...params, priceMax: 1.16 })])
    expect(requests).toHaveLength(2)
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
    symbol: { ticker, shortName: ticker } as SymbolInfo,
    vendor: 'oanda'
  }
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
