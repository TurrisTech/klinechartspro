import { apiGet } from '../config'

// `GET /levels2` — support/resistance ZONES from sparse swing pivots (wdashboard-server
// services/levels2.py; the engine is wtradingindicators' levels2). Mirrors the `Zone2`
// model in schemas.py. Unlike a `Level` (client/levels/api.ts) a zone is a price BAND with
// a lifespan: it comes into force at `effectiveAt`, records every touch (a wick into the
// band that closed back outside) and break (a close beyond it), flips its `role` on each
// break, and is retired -- `retiredAt` set, `active: false` -- by the server-side
// `max_breaks`-th break.
export interface Zone {
  interval: string
  center: number
  low: number
  high: number
  /** Birth side: born as a swing high = 'resistance', as a swing low = 'support'. */
  direction: 'support' | 'resistance'
  /** The side it currently acts on: `direction`, flipped once per break. */
  role: 'support' | 'resistance'
  bornAt: number
  effectiveAt: number
  retiredAt: number | null
  touches: number[]
  breaks: number[]
  /** Pivots merged into the zone, the founder included. */
  members: number
  /** Recency-weighted touches minus breaks, as of the server's last computed bar. */
  score: number
  active: boolean
  /** '#rrggbb' advisory hint keyed off the interval the zone was computed on. */
  color: string
}

export interface FetchZonesParams {
  vendor: string
  symbol: string
  priceMin: number
  priceMax: number
  dateFrom: number
  dateTo: number
  /** Omitted = every interval the server holds a zone document for. */
  intervals?: string[]
  includeRetired?: boolean
}

export async function fetchZones(params: FetchZonesParams): Promise<Zone[]> {
  const zones = await apiGet<Zone[]>('/levels2', {
    vendor: params.vendor,
    symbol: params.symbol,
    price_min: params.priceMin,
    price_max: params.priceMax,
    // Epoch ms, never an ISO date: the server localizes a date string to the instrument's
    // wall clock, which would shift the window away from the visible-range timestamps.
    date_from: params.dateFrom,
    date_to: params.dateTo,
    intervals: params.intervals?.join(','),
    include_retired: params.includeRetired ? 'true' : undefined
  })
  return Array.isArray(zones) ? zones : []
}
