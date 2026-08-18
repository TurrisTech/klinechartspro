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
  | { s: 'replaying'; seriesKey: string; progress: number | null; retryAfterMs: number }

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
