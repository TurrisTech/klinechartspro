import { apiGet, apiUrl, OhlcvApiError } from '../config'

// wdashboard-server's server-computed indicator surface (services/indicators.py). The
// client never learns whether a series is ephemeral or persisted -- it asks for an indicator
// on an instrument/interval and gets points; a `202 replaying` answer just means the server
// is still building the series from the instrument's first bar and should be asked again.

export interface ParamSpec {
  name: string
  type: 'int' | 'float'
  default: number
  min: number | null
  max: number | null
  description: string
}

export interface IndicatorSpec {
  name: string
  version: string
  title: string
  description: string
  nInputs: number
  inputLabels: string[]
  params: ParamSpec[]
  pane: 'main' | 'sub'
  render: 'line' | 'marker'
  valueRange: [number, number] | null
  defaultInputs: Array<Record<string, unknown>>
}

// The node document the server resolves into a SeriesIdentity: which indicator, at which
// version, with which scalar params, over which inputs (an OHLCV column or nested nodes).
export interface SeriesDoc {
  name: string
  version?: string
  params?: Record<string, number>
  inputs?: Array<Record<string, unknown>>
}

export interface IndicatorPoint {
  date: number
  value: number | null
}

export interface DiscoveryResponse {
  indicators: IndicatorSpec[]
  persisted: unknown[]
  persistedEnabled: boolean
  limits: { maxValuesPerRequest: number; maxBatchRequests: number; maxBackfillValues: number }
  serverTime: number
}

export type ValuesResult =
  | { s: 'ok'; seriesKey: string; points: IndicatorPoint[] }
  | { s: 'no_data'; seriesKey: string }
  | { s: 'replaying'; seriesKey: string; phase?: string; progress: number | null; retryAfterMs: number }

// What the server can tell us about ONE fully-specified series -- the two questions the
// catalogue cannot answer, because both depend on the params (and, for servability, on what
// the store holds for this instrument). See wdashboard-server's GET /indicators/resolve.
export interface ResolveResult {
  seriesKey: string
  describe: string
  name: string
  version: string
  params: Record<string, number>
  warmupBars: number
  requiresFullHistory: boolean
  servable: boolean
  reason: string | null
  mode: 'persisted' | 'ephemeral'
  backfillState: string | null
  backfillProgress: number | null
}

let discovery: Promise<DiscoveryResponse> | null = null

export function loadDiscovery(): Promise<DiscoveryResponse> {
  if (!discovery) {
    discovery = apiGet<DiscoveryResponse>('/indicators').catch((err) => {
      discovery = null
      throw err
    })
  }
  return discovery
}

export async function fetchValues(
  vendorSymbol: string,
  resolution: string,
  series: SeriesDoc,
  from: number,
  to: number,
  limit: number | null
): Promise<ValuesResult> {
  const url = apiUrl('/indicators/values', {
    symbol: vendorSymbol,
    resolution,
    series: JSON.stringify(series),
    from,
    to,
    limit: limit ?? undefined
  })
  const response = await fetch(url)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const b = body as { code?: string; detail?: string; field?: string } | null
    throw new OhlcvApiError(
      response.status,
      b?.code ?? 'internal',
      b?.detail ?? `${response.status} from /indicators/values`,
      b?.field
    )
  }
  return body as ValuesResult
}

// One in-flight/settled answer per (instrument, interval, series) -- the params dialog asks
// repeatedly as the user types, and the answer for a given set of numbers never changes
// within a session. Bounded by how many distinct combinations one session actually visits.
const resolveCache = new Map<string, Promise<ResolveResult | null>>()

/** Resolve one series, or `null` when the server cannot answer the question.
 *
 * `null` is deliberately not "unservable": a server without `indicators.resolve` (404), or
 * an unreachable one, must leave the picker exactly as usable as it was before this existed.
 * Only an explicit `servable: false` refuses anything. A 4xx that IS about the series --
 * an unknown indicator, a bad param, a levels series asked for as a scalar -- is a real
 * answer, so it is returned as an unservable result rather than swallowed.
 */
export async function resolveSeries(
  vendorSymbol: string,
  resolution: string,
  series: SeriesDoc
): Promise<ResolveResult | null> {
  const cacheKey = `${vendorSymbol}|${resolution}|${JSON.stringify(series)}`
  const hit = resolveCache.get(cacheKey)
  if (hit) return hit
  const pending = (async (): Promise<ResolveResult | null> => {
    const url = apiUrl('/indicators/resolve', {
      symbol: vendorSymbol,
      resolution,
      series: JSON.stringify(series)
    })
    const response = await fetch(url)
    if (response.status === 404) return null // older server: question unavailable, not "no"
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const b = body as { code?: string; detail?: string } | null
      if (!b?.detail) return null
      return {
        seriesKey: '',
        describe: '',
        name: series.name,
        version: series.version ?? '',
        params: series.params ?? {},
        warmupBars: 0,
        requiresFullHistory: false,
        servable: false,
        reason: b.detail,
        mode: 'ephemeral',
        backfillState: null,
        backfillProgress: null
      }
    }
    return body as ResolveResult
  })().catch(() => {
    // Network failure: forget it so a later attempt can succeed, and say nothing.
    resolveCache.delete(cacheKey)
    return null
  })
  resolveCache.set(cacheKey, pending)
  return pending
}
