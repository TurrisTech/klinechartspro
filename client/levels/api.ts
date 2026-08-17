import { apiGet } from '../config'

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

export async function fetchLevels(params: FetchLevelsParams): Promise<Level[]> {
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
