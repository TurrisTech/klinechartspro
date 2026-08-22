import { apiGet } from './config'

// `GET /capabilities` — what this server supports, so the client degrades instead of
// probing for 400s. Mirrors the `Capabilities` model in schemas.py.

export type Feature =
  | 'getbars.columns'
  | 'getbars.batch'
  | 'getbars.limit'
  | 'levels.intervals'
  | 'levels.dates'
  | 'stream.ping'
  | 'stream.backfill'
  // GET /instrument, and a `config` block on each /search result.
  | 'instrument.config'
  // Server-computed indicators: GET /indicators, /indicators/values and `indicator`
  // subscriptions on WS /stream (wdashboard-server services/indicators.py).
  | 'indicators'
  // The persisted half (config table + algo DB); informational for the client.
  | 'indicators.persisted'
  // GET /indicators/resolve — per-instance warm-up and servability. Gated on, because a
  // server without it 404s, and a 404 alone cannot be told from "that series is unknown".
  | 'indicators.resolve'
  // GET /arev/values — AREV research predictions (wdashboard-server services/arev.py).
  // The client only registers its AREV templates and picker entries when advertised.
  | 'arev'
  // GET /krev/values — krev01 k-NN reversal votes (wdashboard-server services/krev.py).
  // The client only registers its KREV template and picker entry when advertised.
  | 'krev'
  // POST /auth/login, /auth/logout, GET /auth/session — dev only. Client gates its login
  // form on this: a server that doesn't advertise it (prod, today) gets the pre-auth
  // ungated experience rather than a login form nothing can ever satisfy.
  | 'auth'
  // GET/PUT /preferences — dev only, requires 'auth'.
  | 'preferences'

export interface CapabilityLimits {
  maxBarsPerRequest: number
  maxBatchRequests: number
  maxBackfillBarCount: number
  maxSubscriptionsPerConnection: number
}

export interface LevelsCoverage {
  vendor: string
  symbol: string
  intervals: string[]
  computedThrough: number
}

export interface Capabilities {
  version: string
  serverTime: number
  intervals: string[]
  features: Feature[]
  limits: CapabilityLimits
  levels: LevelsCoverage[]
}

// Used when /capabilities is unreachable. Deliberately the conservative reading of the
// contract rather than a guess at a richer server: the documented defaults, and the
// interval set the OHLCV app assigns colors to. A client that renders a degraded-but-
// working chart beats one that refuses to start because discovery failed.
const FALLBACK: Capabilities = {
  version: 'unknown',
  serverTime: 0,
  intervals: [
    '1m',
    '3m',
    '5m',
    '15m',
    '30m',
    '1h',
    '2h',
    '4h',
    '8h',
    '1D',
    '3D',
    '1W',
    '2W',
    '1M',
    '3M',
    '12M',
    '1Y'
  ],
  features: [],
  limits: {
    maxBarsPerRequest: 5000,
    maxBatchRequests: 12,
    maxBackfillBarCount: 500,
    maxSubscriptionsPerConnection: 32
  },
  levels: []
}

let cached: Capabilities = FALLBACK
let inflight: Promise<Capabilities> | null = null

// Resolved once at boot and then read synchronously off `capabilities()`. Never rejects —
// discovery failing must not take the chart down with it.
export function loadCapabilities(): Promise<Capabilities> {
  if (inflight) return inflight
  inflight = apiGet<Capabilities>('/capabilities')
    .then((value) => {
      cached = value
      return value
    })
    .catch((err: unknown) => {
      console.warn('[capabilities] discovery failed, using conservative defaults', err)
      return FALLBACK
    })
  return inflight
}

export function capabilities(): Capabilities {
  return cached
}

export function hasFeature(feature: Feature): boolean {
  return cached.features.includes(feature)
}

// Whether the server advertises computed price levels for this instrument.
export function levelsCoverageFor(vendor: string, symbol: string): LevelsCoverage | undefined {
  return cached.levels.find(
    (entry) =>
      entry.vendor.toLowerCase() === vendor.toLowerCase() &&
      entry.symbol.toUpperCase() === symbol.toUpperCase()
  )
}
