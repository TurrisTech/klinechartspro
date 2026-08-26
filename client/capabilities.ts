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
  // GET /plugins and GET /plugins/{id}/values — the indicator plugin host
  // (wdashboard_server/plugins). Every plugin's points come through one route body; the
  // `plugins` table names what is mounted. Absent (an older server), the client's plugins
  // fetch on their legacy paths instead (client/plugins/api.ts).
  | 'plugins'
  // GET /plugins/signals and /plugins/{id}/signals -- the published signal labels
  // (client/plugins/README.md "Signals"). With it, a labelling plugin's points carry
  // `signal` as the label id (`'long'`, `'top'`) rather than a boolean; without it the
  // client's plugins normalise the old boolean themselves (arev/api.ts `arevSignal`).
  | 'plugins.signals'
  // GET /arev/values — AREV research predictions (wdashboard-server services/arev.py).
  // The client only registers its AREV templates and picker entries when advertised.
  | 'arev'
  // GET /krev/values — krev01 k-NN reversal votes (wdashboard-server services/krev.py).
  // The client only registers its KREV template and picker entry when advertised.
  | 'krev'
  // GET /plugins/mtf01/values — the mtf01 multi-timeframe cascade (wdashboard-server
  // services/mtf01.py): the arrows in `points`, the trades they produced in the `trades`
  // array. The client registers its MTF01 template only when advertised.
  | 'strategy'
  // The /sim/* route set — the paper-trading account (wdashboard-server sim/). The client
  // only shows its "Paper" rail button and mounts the trading panel when advertised.
  | 'sim'
  // Every read route takes `asof` (wdashboard_server/services/asof.py), the read clock a
  // bar replay clamps the chart to. With 'sim', gates the "Replay" rail button.
  | 'asof'
  // GET /levels2 — support/resistance zones (wdashboard-server services/levels2.py),
  // served from the file store. The client only mounts the Zones layer when advertised.
  | 'levels2'
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

export interface PluginInfo {
  id: string
  kind: 'points' | 'series' | 'entities'
  feature: string | null
  available: boolean
}

export interface Capabilities {
  version: string
  serverTime: number
  intervals: string[]
  features: Feature[]
  limits: CapabilityLimits
  levels: LevelsCoverage[]
  /** The mounted indicator plugins; absent on a server without the host. */
  plugins?: PluginInfo[]
  /** Absent on servers older than the levels2 route — read through levels2CoverageFor,
   * which treats missing as empty. */
  levels2?: LevelsCoverage[]
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
  levels: [],
  plugins: [],
  levels2: []
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

// The server's plugin table, empty on a server from before the host.
export function serverPlugins(): PluginInfo[] {
  return cached.plugins ?? []
}

// Whether the server advertises stored levels2 zone documents for this instrument.
export function levels2CoverageFor(vendor: string, symbol: string): LevelsCoverage | undefined {
  return (cached.levels2 ?? []).find(
    (entry) =>
      entry.vendor.toLowerCase() === vendor.toLowerCase() &&
      entry.symbol.toUpperCase() === symbol.toUpperCase()
  )
}
