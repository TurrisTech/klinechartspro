import { apiUrl } from '../config'

// What is left of the client's own knowledge of the server-computed indicator surface
// (wdashboard-server services/indicators.py): the node document a series is addressed by,
// the point it yields, and the one question the registry cannot answer.
//
// The catalogue that used to live here is gone -- the timeseries indicator registry
// (client/tsregistry/) is the one list of server indicators now, and the generic plugin
// fetches values itself. `resolveSeries` stays because it is about a CONCRETE series rather
// than a catalogue entry: whether this instrument, this interval and these exact params can
// be served at all, and what the lead-in costs. That depends on the params and on what the
// store holds, so no registry row can hold the answer.
//
// The client never learns whether a series is ephemeral or persisted -- it asks for an
// indicator on an instrument/interval and gets points.

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
