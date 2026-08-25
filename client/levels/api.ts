import { apiGet, getReadClock } from '../config'

// `GET /levels` — precomputed support/resistance price levels. Mirrors the `Level` model in
// wdashboard-server's schemas.py.
export interface Level {
  interval: string
  price: number
  direction: 'support' | 'resistance'
  bornAt: number
  effectiveAt: number
  invalidations: number[]
  active: boolean
  // '#rrggbb' advisory hint keyed off the interval the level was computed on, so levels
  // from the same timeframe read as a set. Only used when LevelsConfig.base.colorMode is
  // 'server' — see client/levels/config.ts.
  color: string
}

export interface FetchLevelsParams {
  vendor: string
  symbol: string
  priceMin: number
  priceMax: number
  dateFrom: number
  dateTo: number
  /** Omitted (undefined) = every allowlisted interval, matching the server's own default. */
  intervals?: string[]
  /** ohlcv.py:946 defaults this to false server-side — omitted here means the same thing. */
  includeInvalidated?: boolean
}

// Identical requests already in flight, keyed by the query they resolve to. A wall of panes
// on one symbol is the common case and its panes share a time axis, so a pan, a replay step
// or a workspace opening lands two, four or six byte-identical `/levels` reads on the server
// at once — and the browser only has six connections per origin to spend, which the panes'
// own history loads are competing for. Sharing the promise makes those one request.
//
// Only the IN-FLIGHT window is shared: the entry is dropped as soon as the request settles,
// so this is deduplication, never a cache with a lifetime of its own. Deciding when an
// answer stops being current belongs to the layer (levels/layer.ts's `staleAt`), and the
// server's ETag is what makes asking again cheap.
const inFlight = new Map<string, Promise<Level[]>>()

export function fetchLevels(params: FetchLevelsParams): Promise<Level[]> {
  const key = JSON.stringify([
    // The replay's read clock is not a parameter of this call -- `apiUrl` adds it to every
    // read -- but it decides the answer, so two requests under different clocks are two
    // requests. A replay step moves the clock and immediately invalidates the layer, which
    // is exactly the moment an old-clock read could still be in flight.
    getReadClock(),
    params.vendor,
    params.symbol,
    params.priceMin,
    params.priceMax,
    params.dateFrom,
    params.dateTo,
    params.intervals ?? null,
    params.includeInvalidated ?? false
  ])
  const running = inFlight.get(key)
  if (running) return running
  const request = requestLevels(params)
  inFlight.set(key, request)
  // `void` the chained promise: it exists only to clear the entry, and an unhandled
  // rejection on it would be reported separately from the one the caller already sees.
  void request.then(
    () => inFlight.delete(key),
    () => inFlight.delete(key)
  )
  return request
}

/** How many identical requests are being shared right now. Test seam; also the number to
 * watch if `/levels` traffic ever looks higher than the pane count explains. */
export function levelsRequestsInFlight(): number {
  return inFlight.size
}

async function requestLevels(params: FetchLevelsParams): Promise<Level[]> {
  const levels = await apiGet<Level[]>('/levels', {
    vendor: params.vendor,
    symbol: params.symbol,
    price_min: params.priceMin,
    price_max: params.priceMax,
    // All-digit strings are read as epoch ms server-side (ohlcv.py's
    // _parse_levels_date: `text.isdigit()` -> int(text)); a 'YYYY-MM-DD' string would
    // instead be localized to America/New_York midnight, which silently shifts the window
    // away from the visible-range timestamps it was derived from.
    date_from: params.dateFrom,
    date_to: params.dateTo,
    intervals: params.intervals?.join(','),
    include_invalidated: params.includeInvalidated ? 'true' : undefined
  })
  return Array.isArray(levels) ? levels : []
}
